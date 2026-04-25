import { Resolver, lookup, resolveNs } from "node:dns/promises";
import type { IntegrationConfig } from "../types";
import { IntegrationLogger } from "../lib/logger";

const FALLBACK_DUCKDNS_NS = Array.from({ length: 9 }, (_, index) => `ns${index + 1}.duckdns.org`);

/** Handles DNS publication and propagation checks for DuckDNS-backed test hosts. */
export class DuckDnsProvider {
  private readonly domain: string;
  private readonly token: string;
  private readonly logger: IntegrationLogger;
  private authoritativeServers?: Promise<string[]>;

  constructor(config: IntegrationConfig, logger: IntegrationLogger) {
    this.domain = config.duckdnsDomain;
    this.token = config.duckdnsToken;
    this.logger = logger;
  }

  rootDomain(): string {
    return `${this.domain}.duckdns.org`;
  }

  serviceHost(prefix: string, slug: string): string {
    return `${prefix}-${slug}.${this.rootDomain()}`;
  }

  async update(ip: string): Promise<void> {
    const url = new URL("https://www.duckdns.org/update");
    url.searchParams.set("domains", this.domain);
    url.searchParams.set("token", this.token);
    url.searchParams.set("ip", ip);
    this.logger.info(`duckdns update ${this.domain} -> ${ip}`);
    const response = await fetch(url);
    const body = (await response.text()).trim();
    if (!response.ok || body !== "OK") {
      throw new Error(`DuckDNS update failed: HTTP ${response.status} ${body}`);
    }
  }

  async waitForHosts(hosts: string[], expectedIp: string, timeoutMs = 180000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const lastAnswers = new Map<string, string[]>();
    while (Date.now() < deadline) {
      let allMatch = true;
      for (const host of hosts) {
        try {
          const answers = await this.resolveIpv4s(host);
          lastAnswers.set(host, answers);
          if (!answers.includes(expectedIp)) {
            allMatch = false;
            break;
          }
        } catch {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        return;
      }
      await Bun.sleep(5000);
    }
    const rendered = hosts
      .map((host) => `${host}=[${(lastAnswers.get(host) ?? []).join(", ") || "unresolved"}]`)
      .join("; ");
    throw new Error(`DuckDNS propagation did not converge for ${hosts.join(", ")} -> ${expectedIp}; last answers: ${rendered}`);
  }

  private async resolveIpv4s(host: string): Promise<string[]> {
    const authoritativeAnswers = await this.lookupViaAuthoritativeNameservers(host).catch(() => [] as string[]);
    if (authoritativeAnswers.length > 0) {
      return authoritativeAnswers;
    }

    const publicAnswers = await Promise.all([
      this.lookupViaGoogleDnsOverHttps(host).catch(() => [] as string[]),
      this.lookupViaCloudflareDnsOverHttps(host).catch(() => [] as string[])
    ]);
    const merged = [...new Set(publicAnswers.flat().filter((answer) => answer.length > 0))];
    if (merged.length > 0) {
      return merged;
    }
    const localAnswer = await lookup(host, { family: 4 });
    return [localAnswer.address];
  }

  private async lookupViaAuthoritativeNameservers(host: string): Promise<string[]> {
    const nameserverIps = await this.getAuthoritativeNameserverIps();
    const answers = await Promise.all(
      nameserverIps.map(async (serverIp) => {
        const resolver = new Resolver();
        resolver.setServers([serverIp]);
        return await resolver.resolve4(host);
      })
    );
    return [...new Set(answers.flat())];
  }

  private async getAuthoritativeNameserverIps(): Promise<string[]> {
    if (!this.authoritativeServers) {
      this.authoritativeServers = this.resolveAuthoritativeNameserverIps();
    }
    return await this.authoritativeServers;
  }

  private async resolveAuthoritativeNameserverIps(): Promise<string[]> {
    const nsHosts = await resolveNs("duckdns.org").catch(() => FALLBACK_DUCKDNS_NS);
    const nsIps = await Promise.all(
      nsHosts.map(async (host) => {
        const records = await lookup(host, { family: 4, all: true }).catch(() => [] as Array<{ address: string }>);
        return records.map((record) => record.address);
      })
    );
    const flattened = [...new Set(nsIps.flat().filter((address) => address.length > 0))];
    if (flattened.length === 0) {
      throw new Error("failed to resolve DuckDNS authoritative nameserver IPs");
    }
    this.logger.info(`resolved DuckDNS authoritative servers: ${flattened.join(", ")}`);
    return flattened;
  }

  private async lookupViaGoogleDnsOverHttps(host: string): Promise<string[]> {
    const url = new URL("https://dns.google/resolve");
    url.searchParams.set("name", host);
    url.searchParams.set("type", "A");
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`dns.google returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { Answer?: Array<{ type?: number; data?: string }> };
    const answers = (payload.Answer ?? [])
      .filter((record) => record.type === 1 && typeof record.data === "string" && record.data.length > 0)
      .map((record) => record.data as string);
    if (answers.length === 0) {
      throw new Error(`no A record returned for ${host}`);
    }
    return answers;
  }

  private async lookupViaCloudflareDnsOverHttps(host: string): Promise<string[]> {
    const url = new URL("https://cloudflare-dns.com/dns-query");
    url.searchParams.set("name", host);
    url.searchParams.set("type", "A");
    const response = await fetch(url, {
      headers: {
        accept: "application/dns-json"
      }
    });
    if (!response.ok) {
      throw new Error(`cloudflare-dns.com returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { Answer?: Array<{ type?: number; data?: string }> };
    const answers = (payload.Answer ?? [])
      .filter((record) => record.type === 1 && typeof record.data === "string" && record.data.length > 0)
      .map((record) => record.data as string);
    if (answers.length === 0) {
      throw new Error(`no A record returned for ${host}`);
    }
    return answers;
  }
}
