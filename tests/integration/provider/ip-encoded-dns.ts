import { createHash } from "node:crypto";
import type { IntegrationConfig } from "../types";
import { IntegrationLogger } from "../lib/logger";

const DNS_POLL_INTERVAL_MS = 5000;
const DNS_STABLE_POLLS = 2;

type PropagationAnswers = {
  google: string[];
  cloudflare: string[];
};

/** Provides public test hostnames by embedding the server IP in the DNS name. */
export class IpEncodedDnsProvider {
  private readonly domain: string;
  private readonly logger: IntegrationLogger;

  constructor(config: IntegrationConfig, logger: IntegrationLogger) {
    this.domain = normalizeDomain(config.ipDnsDomain);
    this.logger = logger;
  }

  rootDomain(ip: string): string {
    return `${dashedIpv4(ip)}.${this.domain}`;
  }

  serviceHost(prefix: string, slug: string, ip: string): string {
    return `${dnsLabel(`${prefix}-${slug}`)}.${this.rootDomain(ip)}`;
  }

  async waitForHosts(hosts: string[], expectedIp: string, timeoutMs = 120000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let stablePolls = 0;
    const lastAnswers = new Map<string, string>();

    while (Date.now() < deadline) {
      const results = await Promise.all(
        hosts.map(async (host) => {
          const answers = await this.resolvePropagationAnswers(host);
          lastAnswers.set(host, this.renderPropagationAnswers(answers));
          return { host, answers };
        })
      );
      const allMatch = results.every(({ answers }) => this.propagationAnswersMatch(answers, expectedIp));
      if (allMatch) {
        stablePolls += 1;
        if (stablePolls >= DNS_STABLE_POLLS) {
          this.logger.info(`IP-encoded DNS resolved ${hosts.length} host(s) via ${this.domain} -> ${expectedIp}`);
          return;
        }
      } else {
        stablePolls = 0;
      }
      await Bun.sleep(DNS_POLL_INTERVAL_MS);
    }

    const rendered = hosts.map((host) => `${host}=[${lastAnswers.get(host) ?? "unresolved"}]`).join("; ");
    throw new Error(`IP-encoded DNS did not resolve for ${hosts.join(", ")} -> ${expectedIp}; last answers: ${rendered}`);
  }

  private propagationAnswersMatch(answers: PropagationAnswers, expectedIp: string): boolean {
    return [answers.google, answers.cloudflare].every(
      (sourceAnswers) => sourceAnswers.length > 0 && sourceAnswers.every((answer) => answer === expectedIp)
    );
  }

  private renderPropagationAnswers(answers: PropagationAnswers): string {
    return [`google:${answers.google.join(",") || "unresolved"}`, `cloudflare:${answers.cloudflare.join(",") || "unresolved"}`].join(" ");
  }

  private async resolvePropagationAnswers(host: string): Promise<PropagationAnswers> {
    const [google, cloudflare] = await Promise.all([
      this.lookupViaGoogleDnsOverHttps(host).catch(() => [] as string[]),
      this.lookupViaCloudflareDnsOverHttps(host).catch(() => [] as string[])
    ]);
    return { google, cloudflare };
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
    return aRecords(payload, host);
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
    return aRecords(payload, host);
  }
}

function normalizeDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\.$/, "").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("/") || !/^[a-z0-9.-]+$/.test(normalized)) {
    throw new Error(`invalid IP-encoded DNS domain: ${domain}`);
  }
  return normalized;
}

function dashedIpv4(ip: string): string {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    throw new Error(`expected IPv4 address for IP-encoded DNS, got: ${ip}`);
  }
  return parts.join("-");
}

function dnsLabel(value: string): string {
  const label = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "host";
  if (label.length <= 63) {
    return label;
  }
  const hash = createHash("sha256").update(label).digest("hex").slice(0, 10);
  return `${label.slice(0, 52).replace(/-+$/g, "")}-${hash}`;
}

function aRecords(payload: { Answer?: Array<{ type?: number; data?: string }> }, host: string): string[] {
  const answers = (payload.Answer ?? [])
    .filter((record) => record.type === 1 && typeof record.data === "string" && record.data.length > 0)
    .map((record) => record.data as string);
  if (answers.length === 0) {
    throw new Error(`no A record returned for ${host}`);
  }
  return answers;
}
