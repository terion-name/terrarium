import type { IntegrationConfig, ServerRecord, VolumeRecord } from "../types";
import { IntegrationLogger } from "../lib/logger";

type HetznerAction = { id: number; status: string };
type HetznerServerResponse = { server: { id: number; name: string; public_net?: { ipv4?: { ip?: string } } }; action?: HetznerAction };
type HetznerVolumeResponse = { volume: { id: number; name: string; linux_device?: string }; action?: HetznerAction };
type HetznerSshKey = { id: number; name: string; public_key: string };
type HetznerLocation = { name: string; network_zone?: string };

function normalizePublicKey(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
}

/**
 * Minimal Hetzner Cloud REST client for ephemeral integration resources.
 *
 * Using the HTTP API directly keeps local manual runs and Actions consistent
 * without requiring the `hcloud` CLI to be installed.
 */
export class HetznerCloudProvider {
  private readonly token: string;
  private readonly logger: IntegrationLogger;
  private readonly requestedLocation: string;
  private resolvedLocationName = "";

  constructor(config: IntegrationConfig, logger: IntegrationLogger) {
    this.token = config.hcloudToken;
    this.logger = logger;
    this.requestedLocation = config.hcloudLocation.trim();
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.logger.info(`hetzner ${method} ${path}`);
    const response = await fetch(`https://api.hetzner.cloud/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`Hetzner API ${method} ${path} failed with HTTP ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  private async resolveLocationName(): Promise<string> {
    if (this.resolvedLocationName) {
      return this.resolvedLocationName;
    }

    const response = await this.request<{ locations?: HetznerLocation[] }>("GET", "/locations");
    const locations = response.locations ?? [];
    const exact = locations.find((location) => location.name === this.requestedLocation);
    if (exact) {
      this.resolvedLocationName = exact.name;
      return this.resolvedLocationName;
    }

    const matchingZone = locations
      .filter((location) => location.network_zone === this.requestedLocation)
      .sort((left, right) => left.name.localeCompare(right.name));
    if (matchingZone.length > 0) {
      const preferred = matchingZone.find((location) => location.name === "nbg1") ?? matchingZone[0];
      this.resolvedLocationName = preferred.name;
      this.logger.info(`resolved Hetzner network zone ${this.requestedLocation} to location ${this.resolvedLocationName}`);
      return this.resolvedLocationName;
    }

    throw new Error(`unable to resolve Hetzner location ${this.requestedLocation}`);
  }

  async createSshKey(name: string, publicKey: string): Promise<number> {
    const normalized = normalizePublicKey(publicKey);
    const response = await fetch("https://api.hetzner.cloud/v1/ssh_keys", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name,
        public_key: normalized
      })
    });
    if (response.ok) {
      const payload = (await response.json()) as { ssh_key: { id: number } };
      return payload.ssh_key.id;
    }

    const body = await response.text();
    if (response.status === 409 && body.includes("public_key")) {
      const existing = await this.findSshKeyByPublicKey(normalized);
      if (existing) {
        this.logger.info(`reuse existing Hetzner SSH key ${existing.id} (${existing.name})`);
        return existing.id;
      }
    }
    throw new Error(`Hetzner API POST /ssh_keys failed with HTTP ${response.status}: ${body}`);
  }

  private async findSshKeyByPublicKey(publicKey: string): Promise<HetznerSshKey | null> {
    const response = await this.request<{ ssh_keys?: HetznerSshKey[] }>("GET", "/ssh_keys");
    const normalized = normalizePublicKey(publicKey);
    return (response.ssh_keys ?? []).find((key) => normalizePublicKey(key.public_key) === normalized) ?? null;
  }

  async deleteSshKey(id: number): Promise<void> {
    const response = await fetch(`https://api.hetzner.cloud/v1/ssh_keys/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.token}` }
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`failed to delete Hetzner SSH key ${id}: HTTP ${response.status}`);
    }
  }

  async createServer(
    name: string,
    serverType: string,
    location: string,
    sshKeyIds: number[],
    labels: Record<string, string>
  ): Promise<ServerRecord> {
    const resolvedLocation = await this.resolveLocationName();
    const response = await this.request<HetznerServerResponse>("POST", "/servers", {
      name,
      server_type: serverType,
      image: "ubuntu-24.04",
      location: resolvedLocation || location,
      ssh_keys: sshKeyIds,
      labels
    });
    if (response.action) {
      await this.waitForAction(response.action.id);
    }
    return await this.waitForServer(response.server.id);
  }

  async waitForServer(id: number, timeoutMs = 240000): Promise<ServerRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await this.request<{ server: { id: number; name: string; public_net?: { ipv4?: { ip?: string } } } }>("GET", `/servers/${id}`);
      const ip = response.server.public_net?.ipv4?.ip;
      if (ip) {
        return { id: response.server.id, name: response.server.name, ipv4: ip };
      }
      await Bun.sleep(3000);
    }
    throw new Error(`timed out waiting for Hetzner server ${id} IPv4`);
  }

  async deleteServer(id: number): Promise<void> {
    const response = await fetch(`https://api.hetzner.cloud/v1/servers/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.token}` }
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`failed to delete Hetzner server ${id}: HTTP ${response.status}`);
    }
  }

  async createVolume(name: string, sizeGb: number, location: string, labels: Record<string, string>): Promise<VolumeRecord> {
    const resolvedLocation = await this.resolveLocationName();
    const response = await this.request<HetznerVolumeResponse>("POST", "/volumes", {
      name,
      size: sizeGb,
      location: resolvedLocation || location,
      labels,
      format: ""
    });
    if (response.action) {
      await this.waitForAction(response.action.id);
    }
    return {
      id: response.volume.id,
      name: response.volume.name,
      linuxDevice: response.volume.linux_device
    };
  }

  async attachVolume(volumeId: number, serverId: number): Promise<VolumeRecord> {
    const response = await this.request<HetznerVolumeResponse>("POST", `/volumes/${volumeId}/actions/attach`, {
      server: serverId,
      automount: false
    });
    if (response.action) {
      await this.waitForAction(response.action.id);
    }
    const volume = await this.request<{ volume: { id: number; name: string; linux_device?: string } }>("GET", `/volumes/${volumeId}`);
    return {
      id: volume.volume.id,
      name: volume.volume.name,
      linuxDevice: volume.volume.linux_device
    };
  }

  async deleteVolume(id: number): Promise<void> {
    const response = await fetch(`https://api.hetzner.cloud/v1/volumes/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.token}` }
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`failed to delete Hetzner volume ${id}: HTTP ${response.status}`);
    }
  }

  private async waitForAction(actionId: number, timeoutMs = 240000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await this.request<{ action: HetznerAction; error?: { message?: string } }>("GET", `/actions/${actionId}`);
      if (response.action.status === "success") {
        return;
      }
      if (response.action.status === "error") {
        throw new Error(`Hetzner action ${actionId} failed: ${response.error?.message || "unknown error"}`);
      }
      await Bun.sleep(2500);
    }
    throw new Error(`timed out waiting for Hetzner action ${actionId}`);
  }
}
