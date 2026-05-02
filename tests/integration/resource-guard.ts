import type { IntegrationLogger } from "./lib/logger";
import type { HetznerCloudProvider } from "./provider/hetzner";
import type { CleanupManifestStore } from "./resources";

type ResourceGuardOptions = {
  resources: CleanupManifestStore;
  hetzner: Pick<HetznerCloudProvider, "serverExists">;
  logger: IntegrationLogger;
  intervalMs?: number;
  onFatal: (error: Error) => void | Promise<void>;
};

const DEFAULT_RESOURCE_GUARD_INTERVAL_MS = 60_000;

/**
 * Fails a real-infra run when tracked Hetzner servers disappear outside the harness.
 *
 * Without this, long remote waits can keep polling deleted hosts until the
 * GitHub Actions job timeout wins. Expected release/cleanup deletions are
 * marked explicitly so normal teardown remains idempotent.
 */
export class IntegrationResourceGuard {
  private readonly expectedServerDeletes = new Set<number>();
  private readonly intervalMs: number;
  private timer: Timer | undefined;
  private checking = false;
  private stopped = false;

  constructor(private readonly options: ResourceGuardOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_RESOURCE_GUARD_INTERVAL_MS;
  }

  start(): void {
    if (this.timer || this.stopped) {
      return;
    }
    this.timer = setInterval(() => {
      void this.checkOnce();
    }, this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async allowExpectedServerDeletion<T>(serverId: number, task: () => Promise<T>): Promise<T> {
    this.expectedServerDeletes.add(serverId);
    try {
      return await task();
    } finally {
      this.expectedServerDeletes.delete(serverId);
    }
  }

  async checkOnce(): Promise<void> {
    if (this.stopped || this.checking) {
      return;
    }

    this.checking = true;
    try {
      const servers = this.options.resources
        .snapshot()
        .hetzner.servers.filter((server) => !this.expectedServerDeletes.has(server.id));
      if (servers.length === 0) {
        return;
      }

      const missing: string[] = [];
      for (const server of servers) {
        const exists = await this.options.hetzner.serverExists(server.id);
        if (!exists) {
          missing.push(`${server.label}/${server.name} (${server.id})`);
        }
      }

      if (missing.length === 0) {
        return;
      }

      this.stop();
      await this.options.onFatal(
        new Error(
          `tracked Hetzner server disappeared outside the integration harness: ${missing.join(
            ", "
          )}. Failing fast instead of waiting for remote SSH/browser timeouts.`
        )
      );
    } catch (error) {
      this.options.logger.warn(`resource guard check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.checking = false;
    }
  }
}
