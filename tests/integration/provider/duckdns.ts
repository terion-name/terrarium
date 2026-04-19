import { lookup } from "node:dns/promises";
import type { IntegrationConfig } from "../types";
import { IntegrationLogger } from "../lib/logger";

/** Handles DNS publication and propagation checks for DuckDNS-backed test hosts. */
export class DuckDnsProvider {
  private readonly domain: string;
  private readonly token: string;
  private readonly logger: IntegrationLogger;

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
    while (Date.now() < deadline) {
      let allMatch = true;
      for (const host of hosts) {
        try {
          const answer = await lookup(host, { family: 4 });
          if (answer.address !== expectedIp) {
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
    throw new Error(`DuckDNS propagation did not converge for ${hosts.join(", ")} -> ${expectedIp}`);
  }
}
