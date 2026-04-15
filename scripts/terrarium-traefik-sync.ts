import { URL } from "node:url";
import { configString, loadConfig, readJsonFile, runAllowFailure, runJson, runText, writeIfChanged, writeJsonFile, yamlStringify } from "./lib/common";

const PREFIX = "terrariumctl proxy sync";
const DEFAULT_CONFIG_PATH = "/etc/terrarium/config.yaml";
const STATIC_CONFIG_PATH = "/etc/traefik/traefik.yml";
const DYNAMIC_CONFIG_PATH = "/etc/traefik/dynamic/terrarium-lxc.yml";
const UFW_STATE_PATH = "/var/lib/terrarium/traefik-ufw-state.json";

type LxcAddress = {
  family?: string;
  scope?: string;
  address?: string;
};

type LxcNetwork = {
  addresses?: LxcAddress[];
};

type LxcInstance = {
  name?: string;
  config?: Record<string, string>;
  state?: {
    network?: Record<string, LxcNetwork>;
  };
};

type DesiredPort = {
  proto: "tcp" | "udp";
  port: number;
};

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "route";
}

function splitProxyItems(rawValue: string): string[] {
  return rawValue
    .replaceAll("\n", ",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function findIpv4(instance: LxcInstance): string | null {
  for (const iface of Object.values(instance.state?.network ?? {})) {
    for (const address of iface.addresses ?? []) {
      if (address.family === "inet" && address.scope === "global" && address.address) {
        return address.address;
      }
    }
  }
  return null;
}

function parseProxyItem(item: string):
  | { kind: "http"; scheme: "http" | "https"; host: string; path: string; targetPort: number }
  | { kind: "tcp" | "udp"; hostPort: number; containerPort: number } {
  if (item.startsWith("http://") || item.startsWith("https://")) {
    const parsed = new URL(item);
    if (parsed.search || parsed.hash) {
      throw new Error(`query strings and fragments are not supported: ${item}`);
    }
    return {
      kind: "http",
      scheme: parsed.protocol.replace(":", "") as "http" | "https",
      host: parsed.hostname,
      path: parsed.pathname || "/",
      targetPort: parsed.port ? Number(parsed.port) : 80
    };
  }

  const match = /^(tcp|udp):\/\/([0-9]{1,5}):([0-9]{1,5})$/.exec(item);
  if (!match) {
    throw new Error(`unsupported proxy value: ${item}`);
  }

  return {
    kind: match[1] as "tcp" | "udp",
    hostPort: Number(match[2]),
    containerPort: Number(match[3])
  };
}

function loadUfwState(): DesiredPort[] {
  return readJsonFile<DesiredPort[]>(UFW_STATE_PATH, []);
}

async function ensureUfwRule(proto: "tcp" | "udp", port: number): Promise<void> {
  await runText(
    ["ufw", "--force", "allow", "proto", proto, "from", "any", "to", "any", "port", String(port), "comment", "terrarium-proxy"],
    PREFIX
  );
}

async function deleteUfwRule(proto: "tcp" | "udp", port: number): Promise<void> {
  await runAllowFailure(["ufw", "--force", "delete", "allow", "proto", proto, "from", "any", "to", "any", "port", String(port)]);
}

async function syncUfw(desiredPorts: DesiredPort[]): Promise<string[]> {
  if (!Bun.which("ufw")) {
    return ["ufw not found; skipped firewall sync"];
  }

  const previous = loadUfwState();
  const desiredSet = new Set(desiredPorts.map((item) => `${item.proto}:${item.port}`));
  const previousSet = new Set(previous.map((item) => `${item.proto}:${item.port}`));
  const applied = new Set(previousSet);
  const errors: string[] = [];

  for (const item of previousSet) {
    if (desiredSet.has(item)) {
      continue;
    }
    const [proto, port] = item.split(":");
    await deleteUfwRule(proto as "tcp" | "udp", Number(port));
    applied.delete(item);
  }

  for (const item of desiredSet) {
    if (previousSet.has(item)) {
      continue;
    }
    const [proto, port] = item.split(":");
    try {
      await ensureUfwRule(proto as "tcp" | "udp", Number(port));
      applied.add(item);
    } catch (error) {
      errors.push(`failed to add UFW rule ${proto}/${port}: ${String(error)}`);
    }
  }

  writeJsonFile(
    UFW_STATE_PATH,
    [...applied]
      .sort()
      .map((item) => {
        const [proto, port] = item.split(":");
        return { proto, port: Number(port) };
      })
  );

  return errors;
}

function buildStaticConfig(config: Record<string, unknown>, extraEntrypoints: Record<string, { address: string }>): string {
  return yamlStringify({
    entryPoints: {
      web: { address: ":80" },
      websecure: { address: ":443" },
      ...extraEntrypoints
    },
    providers: {
      file: {
        directory: "/etc/traefik/dynamic",
        watch: true
      }
    },
    certificatesResolvers: {
      letsencrypt: {
        acme: {
          email: configString(config, "terrarium_acme_email") || configString(config, "terrarium_email"),
          storage: "/var/lib/traefik/acme.json",
          httpChallenge: {
            entryPoint: "web"
          }
        }
      }
    },
    log: { level: "INFO" }
  });
}

function buildDynamicConfig(containers: LxcInstance[]): {
  dynamicYaml: string;
  extraEntrypoints: Record<string, { address: string }>;
  ufwPorts: DesiredPort[];
  errors: string[];
} {
  const dynamic: Record<string, unknown> = {
    http: {
      middlewares: {
        "terrarium-redirect-to-https": {
          redirectScheme: {
            scheme: "https"
          }
        }
      },
      routers: {},
      services: {}
    },
    tcp: {
      routers: {},
      services: {}
    },
    udp: {
      routers: {},
      services: {}
    }
  };

  const httpRouters = (dynamic.http as Record<string, unknown>).routers as Record<string, unknown>;
  const httpServices = (dynamic.http as Record<string, unknown>).services as Record<string, unknown>;
  const tcpRouters = (dynamic.tcp as Record<string, unknown>).routers as Record<string, unknown>;
  const tcpServices = (dynamic.tcp as Record<string, unknown>).services as Record<string, unknown>;
  const udpRouters = (dynamic.udp as Record<string, unknown>).routers as Record<string, unknown>;
  const udpServices = (dynamic.udp as Record<string, unknown>).services as Record<string, unknown>;
  const extraEntrypoints: Record<string, { address: string }> = {};
  const ufwPorts: DesiredPort[] = [];
  const httpClaims = new Set<string>();
  const portClaims = new Set<string>();
  const errors: string[] = [];

  for (const container of containers) {
    const name = container.name ?? "unknown";
    const label = container.config?.["user.proxy"]?.trim() ?? "";
    if (!label) {
      continue;
    }

    const ipAddress = findIpv4(container);
    if (!ipAddress) {
      errors.push(`${name}: skipped because no global IPv4 address is available`);
      continue;
    }

    for (const [index, rawItem] of splitProxyItems(label).entries()) {
      let item: ReturnType<typeof parseProxyItem>;
      try {
        item = parseProxyItem(rawItem);
      } catch (error) {
        errors.push(`${name}: ${String(error).replace(/^Error: /, "")}`);
        continue;
      }

      if (item.kind === "http") {
        const claim = `${item.scheme}:${item.host}:${item.path}`;
        if (httpClaims.has(claim)) {
          errors.push(`${name}: duplicate HTTP route ${rawItem}`);
          continue;
        }
        httpClaims.add(claim);

        const suffix = slugify(`${name}-${item.host}-${item.targetPort}-${index}`);
        const serviceName = `lxc-${suffix}`;
        httpServices[serviceName] = {
          loadBalancer: {
            servers: [{ url: `http://${ipAddress}:${item.targetPort}` }]
          }
        };

        let rule = `Host(\`${item.host}\`)`;
        if (item.path !== "/") {
          rule += ` && PathPrefix(\`${item.path}\`)`;
        }

        if (item.scheme === "https") {
          httpRouters[`${serviceName}-http`] = {
            entryPoints: ["web"],
            rule,
            service: serviceName,
            middlewares: ["terrarium-redirect-to-https"]
          };
          httpRouters[`${serviceName}-https`] = {
            entryPoints: ["websecure"],
            rule,
            service: serviceName,
            tls: { certResolver: "letsencrypt" }
          };
        } else {
          httpRouters[`${serviceName}-http`] = {
            entryPoints: ["web"],
            rule,
            service: serviceName
          };
        }
        continue;
      }

      const claim = `${item.kind}:${item.hostPort}`;
      if (portClaims.has(claim)) {
        errors.push(`${name}: duplicate ${item.kind.toUpperCase()} host port ${item.hostPort}`);
        continue;
      }
      portClaims.add(claim);

      const entrypointName = `${item.kind}-${item.hostPort}`;
      extraEntrypoints[entrypointName] = {
        address: `:${item.hostPort}/${item.kind}`
      };
      ufwPorts.push({ proto: item.kind, port: item.hostPort });

      const serviceSuffix = slugify(`${name}-${item.kind}-${item.hostPort}`);
      const serviceName = `lxc-${serviceSuffix}`;
      if (item.kind === "tcp") {
        tcpServices[serviceName] = {
          loadBalancer: {
            servers: [{ address: `${ipAddress}:${item.containerPort}` }]
          }
        };
        tcpRouters[`${serviceName}-router`] = {
          entryPoints: [entrypointName],
          rule: "HostSNI(`*`)",
          service: serviceName
        };
      } else {
        udpServices[serviceName] = {
          loadBalancer: {
            servers: [{ address: `${ipAddress}:${item.containerPort}` }]
          }
        };
        udpRouters[`${serviceName}-router`] = {
          entryPoints: [entrypointName],
          service: serviceName
        };
      }
    }
  }

  if (Object.keys(httpRouters).length === 0) {
    delete (dynamic.http as Record<string, unknown>).middlewares;
  }
  if (Object.keys(httpRouters).length === 0 && Object.keys(httpServices).length === 0) {
    delete dynamic.http;
  }
  if (Object.keys(tcpRouters).length === 0 && Object.keys(tcpServices).length === 0) {
    delete dynamic.tcp;
  }
  if (Object.keys(udpRouters).length === 0 && Object.keys(udpServices).length === 0) {
    delete dynamic.udp;
  }

  return {
    dynamicYaml: yamlStringify(dynamic),
    extraEntrypoints,
    ufwPorts,
    errors
  };
}

export async function proxySyncCmd(configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  const config = loadConfig(configPath, PREFIX);
  const containers = await runJson<LxcInstance[]>(["lxc", "list", "-f", "json"], PREFIX);
  const { dynamicYaml, extraEntrypoints, ufwPorts, errors } = buildDynamicConfig(containers);
  const staticYaml = buildStaticConfig(config, extraEntrypoints);

  const staticChanged = writeIfChanged(STATIC_CONFIG_PATH, staticYaml);
  writeIfChanged(DYNAMIC_CONFIG_PATH, dynamicYaml);
  const ufwErrors = await syncUfw(ufwPorts);

  if (staticChanged) {
    await runText(["systemctl", "restart", "traefik"], PREFIX);
  }

  for (const error of [...errors, ...ufwErrors]) {
    console.error(`${PREFIX}: ${error}`);
  }
}
