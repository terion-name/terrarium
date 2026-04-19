import { URL } from "node:url";
import { mkdirSync, readFileSync } from "node:fs";
import { configString, loadConfig, readJsonFile, runAllowFailure, runText, writeIfChanged, writeJsonFile, yamlStringify } from "./lib/common";

const PREFIX = "terrariumctl proxy sync";
const DEFAULT_CONFIG_PATH = "/etc/terrarium/config.yaml";
const STATIC_CONFIG_PATH = "/etc/traefik/traefik.yml";
const DYNAMIC_CONFIG_PATH = "/etc/traefik/dynamic/terrarium-lxc.yml";
const UFW_STATE_PATH = "/var/lib/terrarium/traefik-ufw-state.json";
const OAUTH2_PROXY_COOKIE_SECRET_PATH = "/etc/terrarium/secrets/oauth2_proxy_cookie_secret";
const ROUTE_AUTH_DIR = "/var/lib/terrarium/oauth2-proxy-routes";
const ROUTE_AUTH_COMPOSE_PATH = `${ROUTE_AUTH_DIR}/docker-compose.yml`;
const ROUTE_AUTH_BASE_PORT = 4181;
const ROUTE_AUTH_GROUP_BASE_PORT = 4200;

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

type LxcState = {
  network?: Record<string, LxcNetwork>;
};

type DesiredPort = {
  proto: "tcp" | "udp";
  port: number;
};

type AuthSpec = {
  enabled: boolean;
  groups: string[];
};

type HttpProxyItem = {
  kind: "http";
  scheme: "http" | "https";
  host: string;
  path: string;
  targetPort: number;
  auth: AuthSpec;
};

type TransportProxyItem = { kind: "tcp" | "udp"; hostPort: number; containerPort: number };

type RouteAuthProfile = {
  key: string;
  groups: string[];
  port: number;
  callbackPath: string;
  middlewareName: string;
  serviceName: string;
  containerName: string;
};

/**
 * Extracts a JSON document from command output that may contain leading chatter.
 *
 * Fresh Ubuntu hosts can emit bootstrap messages such as `Installing LXD...`
 * before the actual JSON payload appears. Traefik sync should tolerate that
 * during first install instead of aborting the whole converge.
 */
function parseJsonFromOutput<T>(raw: string): T | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  for (const marker of ["[", "{"]) {
    const index = trimmed.indexOf(marker);
    if (index === -1) {
      continue;
    }
    try {
      return JSON.parse(trimmed.slice(index)) as T;
    } catch {
      continue;
    }
  }

  return null;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "route";
}

function splitProxyItems(rawValue: string): string[] {
  const normalized = rawValue.replaceAll("\n", ",");
  const items: string[] = [];
  let current = "";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char !== ",") {
      current += char;
      continue;
    }

    const remainder = normalized.slice(index + 1).trimStart();
    if (/^(https?:\/\/|tcp:\/\/|udp:\/\/)/.test(remainder)) {
      if (current.trim()) {
        items.push(current.trim());
      }
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    items.push(current.trim());
  }

  return items;
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

function parseAuthSuffix(item: string): { route: string; auth: AuthSpec } {
  const authIndex = item.lastIndexOf("@auth");
  if (authIndex === -1) {
    return { route: item, auth: { enabled: false, groups: [] } };
  }

  const suffix = item.slice(authIndex);
  if (!/^@auth(?::[A-Za-z0-9._,-]+)?$/.test(suffix)) {
    throw new Error(`unsupported auth suffix: ${suffix}`);
  }

  const groups = suffix.includes(":")
    ? suffix
        .slice(suffix.indexOf(":") + 1)
        .split(",")
        .map((group) => group.trim())
        .filter(Boolean)
    : [];

  return {
    route: item.slice(0, authIndex),
    auth: {
      enabled: true,
      groups: [...new Set(groups)].sort()
    }
  };
}

function parseProxyItem(item: string): HttpProxyItem | TransportProxyItem {
  const { route, auth } = parseAuthSuffix(item);

  if (route.startsWith("http://") || route.startsWith("https://")) {
    const parsed = new URL(route);
    if (parsed.search || parsed.hash) {
      throw new Error(`query strings and fragments are not supported: ${item}`);
    }
    return {
      kind: "http",
      scheme: parsed.protocol.replace(":", "") as "http" | "https",
      host: parsed.hostname,
      path: parsed.pathname || "/",
      targetPort: parsed.port ? Number(parsed.port) : 80,
      auth
    };
  }

  if (auth.enabled) {
    throw new Error("auth protection is supported only for http:// and https:// routes");
  }

  const match = /^(tcp|udp):\/\/([0-9]{1,5}):([0-9]{1,5})$/.exec(route);
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

async function enrichInstanceState(containers: LxcInstance[]): Promise<LxcInstance[]> {
  const enriched: LxcInstance[] = [];

  for (const container of containers) {
    if (container.state?.network || !container.name) {
      enriched.push(container);
      continue;
    }

    const response = await runAllowFailure(["timeout", "15s", "lxc", "query", `/1.0/instances/${container.name}/state`]);
    if (response.exitCode !== 0) {
      enriched.push(container);
      continue;
    }

    try {
      const state = JSON.parse(response.stdout || "{}") as LxcState;
      enriched.push({
        ...container,
        state
      });
    } catch {
      enriched.push(container);
    }
  }

  return enriched;
}

async function ensureUfwRule(proto: "tcp" | "udp", port: number): Promise<void> {
  await runText(
    ["ufw", "allow", "proto", proto, "from", "any", "to", "any", "port", String(port), "comment", "terrarium-proxy"],
    PREFIX
  );
}

async function deleteUfwRule(proto: "tcp" | "udp", port: number): Promise<void> {
  await runAllowFailure(["bash", "-lc", `yes | ufw delete allow proto ${proto} from any to any port ${port} comment terrarium-proxy`]);
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

/**
 * Loads LXC instances for proxy generation.
 *
 * During initial host provisioning the Traefik role runs before the LXD role,
 * so `lxc list -f json` may still print bootstrap text or fail entirely. In
 * that case we fall back to an empty instance list and let later sync runs pick
 * up container routes once LXD is actually ready.
 */
async function loadInstancesForProxySync(): Promise<LxcInstance[]> {
  const result = await runAllowFailure(["timeout", "15s", "lxc", "list", "-f", "json"]);
  if (result.exitCode !== 0) {
    console.warn(`${PREFIX}: LXD is not ready yet; skipping container route discovery`);
    return [];
  }

  const parsed = parseJsonFromOutput<LxcInstance[]>(result.stdout);
  if (!parsed) {
    console.warn(`${PREFIX}: LXD output was not valid JSON yet; skipping container route discovery`);
    return [];
  }

  return parsed;
}

function routeHostAllowedForSharedAuth(host: string, rootDomain: string, manageDomain: string): boolean {
  if (!rootDomain) {
    return host === manageDomain;
  }
  return host === rootDomain || host.endsWith(`.${rootDomain}`);
}

function buildRouteAuthProfiles(containers: LxcInstance[], config: Record<string, unknown>): { profiles: RouteAuthProfile[]; errors: string[] } {
  const rootDomain = configString(config, "terrarium_root_domain");
  const manageDomain = configString(config, "terrarium_manage_domain");
  const profileGroups = new Map<string, string[]>();
  const errors: string[] = [];

  for (const container of containers) {
    const name = container.name ?? "unknown";
    const label = container.config?.["user.proxy"]?.trim() ?? "";
    if (!label) {
      continue;
    }

    for (const rawItem of splitProxyItems(label)) {
      let parsed: HttpProxyItem | TransportProxyItem;
      try {
        parsed = parseProxyItem(rawItem);
      } catch (error) {
        errors.push(`${name}: ${String(error).replace(/^Error: /, "")}`);
        continue;
      }

      if (parsed.kind !== "http" || !parsed.auth.enabled) {
        continue;
      }

      if (!routeHostAllowedForSharedAuth(parsed.host, rootDomain, manageDomain)) {
        errors.push(`${name}: auth-protected route host ${parsed.host} must be ${manageDomain} or a subdomain of ${rootDomain}`);
        continue;
      }

      const key = parsed.auth.groups.join(",");
      profileGroups.set(key, parsed.auth.groups);
    }
  }

  const profiles: RouteAuthProfile[] = profileGroups.size > 0
    ? [
        {
          key: "",
          groups: [],
          port: ROUTE_AUTH_BASE_PORT,
          callbackPath: "/oauth2/app/callback",
          middlewareName: "lxc-auth-default",
          serviceName: "oauth2-proxy-route-app",
          containerName: "app"
        }
      ]
    : [];

  for (const [index, [key, groups]] of [...profileGroups.entries()].filter(([key]) => key).sort(([a], [b]) => a.localeCompare(b)).entries()) {
    const suffix = slugify(key);
    profiles.push({
      key,
      groups,
      port: ROUTE_AUTH_GROUP_BASE_PORT + index,
      callbackPath: "/oauth2/app/callback",
      middlewareName: `lxc-auth-${suffix}`,
      serviceName: `oauth2-proxy-route-${suffix}`,
      containerName: `groups-${suffix}`
    });
  }

  return { profiles, errors };
}

function buildRouteAuthCompose(
  config: Record<string, unknown>,
  profiles: RouteAuthProfile[],
  clientId: string,
  clientSecret: string,
  cookieSecret: string
): string {
  const issuer = configString(config, "terrarium_oidc_issuer");
  const manageDomain = configString(config, "terrarium_manage_domain");
  const rootDomain = configString(config, "terrarium_root_domain") || manageDomain;

  const services = Object.fromEntries(
    profiles.map((profile) => {
      const cfgLines = [
        'provider = "oidc"',
        'provider_display_name = "Terrarium"',
        `http_address = "127.0.0.1:${profile.port}"`,
        `redirect_url = "https://${manageDomain}${profile.callbackPath}"`,
        `oidc_issuer_url = "${issuer}"`,
        'oidc_groups_claim = "groups"',
        `client_id = "${clientId}"`,
        `client_secret = "${clientSecret}"`,
        `cookie_secret = "${cookieSecret}"`,
        "cookie_secure = true",
        `cookie_domains = [ "${rootDomain}" ]`,
        `whitelist_domains = [ "${rootDomain}", "${manageDomain}" ]`,
        'email_domains = [ "*" ]',
        'upstreams = [ "static://202" ]',
        'scope = "openid profile email"',
        "reverse_proxy = true",
        'code_challenge_method = "S256"',
        "skip_provider_button = true",
        "set_xauthrequest = true",
        "pass_authorization_header = true",
        "pass_user_headers = true",
        "pass_access_token = false",
        "skip_jwt_bearer_tokens = true",
        "ssl_insecure_skip_verify = false"
      ];
      if (profile.groups.length > 0) {
        cfgLines.push(`allowed_groups = [ ${profile.groups.map((group) => `"${group}"`).join(", ")} ]`);
      }

      return [
        profile.containerName,
        {
          image: "quay.io/oauth2-proxy/oauth2-proxy:v7.13.0",
          user: "0:0",
          network_mode: "host",
          restart: "unless-stopped",
          command: ["--config=/etc/oauth2-proxy/oauth2-proxy.cfg"],
          volumes: [`${ROUTE_AUTH_DIR}/${profile.containerName}.cfg:/etc/oauth2-proxy/oauth2-proxy.cfg:ro`],
          environment: {
            TERRARIUM_ROUTE_AUTH_CONFIG: cfgLines.join("\n")
          }
        }
      ];
    })
  );

  for (const profile of profiles) {
    writeIfChanged(`${ROUTE_AUTH_DIR}/${profile.containerName}.cfg`, `${(services[profile.containerName] as { environment: { TERRARIUM_ROUTE_AUTH_CONFIG: string } }).environment.TERRARIUM_ROUTE_AUTH_CONFIG}\n`);
    delete (services[profile.containerName] as { environment?: unknown }).environment;
  }

  return yamlStringify({ services });
}

async function syncRouteAuthStack(config: Record<string, unknown>, profiles: RouteAuthProfile[]): Promise<string[]> {
  const errors: string[] = [];
  mkdirSync(ROUTE_AUTH_DIR, { recursive: true });

  if (profiles.length === 0) {
    writeIfChanged(ROUTE_AUTH_COMPOSE_PATH, yamlStringify({ services: {} }));
    await runAllowFailure(["docker", "compose", "-f", ROUTE_AUTH_COMPOSE_PATH, "down", "--remove-orphans"]);
    return errors;
  }

  const cookieSecret = readFileSync(OAUTH2_PROXY_COOKIE_SECRET_PATH, "utf8").trim();
  const idpMode = configString(config, "terrarium_idp_mode");
  const outputs = idpMode === "local" ? readJsonFile<Record<string, { value?: string }>>("/etc/terrarium/zitadel-apps.json", {}) : {};
  const clientId =
    (idpMode === "local" ? outputs.routes_client_id?.value : undefined) || configString(config, "terrarium_oidc_client_id");
  const clientSecret =
    (idpMode === "local" ? outputs.routes_client_secret?.value : undefined) || configString(config, "terrarium_oidc_client_secret");

  if (!configString(config, "terrarium_oidc_issuer")) {
    errors.push("route auth requires terrarium_oidc_issuer");
    return errors;
  }
  if (!clientId || !clientSecret) {
    errors.push("route auth requires an OIDC client with redirect URI https://manage.<domain>/oauth2/app/callback");
    return errors;
  }
  if (![16, 24, 32].includes(cookieSecret.length)) {
    errors.push("route auth cookie secret is invalid");
    return errors;
  }

  const composeYaml = buildRouteAuthCompose(config, profiles, clientId, clientSecret, cookieSecret);
  writeIfChanged(ROUTE_AUTH_COMPOSE_PATH, composeYaml);
  const result = await runAllowFailure(["docker", "compose", "-f", ROUTE_AUTH_COMPOSE_PATH, "up", "-d", "--remove-orphans"]);
  if (result.exitCode !== 0) {
    errors.push(result.stderr.trim() || result.stdout.trim() || "failed to reconcile route auth stack");
  }

  return errors;
}

function buildStaticConfig(config: Record<string, unknown>, extraEntrypoints: Record<string, { address: string }>): string {
  return yamlStringify({
    api: {},
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

function buildDynamicConfig(containers: LxcInstance[], config: Record<string, unknown>): {
  dynamicYaml: string;
  extraEntrypoints: Record<string, { address: string }>;
  ufwPorts: DesiredPort[];
  authProfiles: RouteAuthProfile[];
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
  const httpMiddlewares = (dynamic.http as Record<string, unknown>).middlewares as Record<string, unknown>;
  const tcpRouters = (dynamic.tcp as Record<string, unknown>).routers as Record<string, unknown>;
  const tcpServices = (dynamic.tcp as Record<string, unknown>).services as Record<string, unknown>;
  const udpRouters = (dynamic.udp as Record<string, unknown>).routers as Record<string, unknown>;
  const udpServices = (dynamic.udp as Record<string, unknown>).services as Record<string, unknown>;
  const extraEntrypoints: Record<string, { address: string }> = {};
  const ufwPorts: DesiredPort[] = [];
  const httpClaims = new Set<string>();
  const portClaims = new Set<string>();
  const errors: string[] = [];
  const { profiles: authProfiles, errors: authProfileErrors } = buildRouteAuthProfiles(containers, config);
  errors.push(...authProfileErrors);
  const authProfileByKey = new Map(authProfiles.map((profile) => [profile.key, profile]));

  if (authProfiles.length > 0) {
    httpRouters["lxc-oauth2-app"] = {
      entryPoints: ["websecure"],
      rule: `Host(\`${configString(config, "terrarium_manage_domain")}\`) && PathPrefix(\`/oauth2/app/\`)`,
      service: "oauth2-proxy-route-app",
      priority: 600,
      tls: { certResolver: "letsencrypt" }
    };
    httpServices["oauth2-proxy-route-app"] = {
      loadBalancer: {
        servers: [{ url: `http://127.0.0.1:${ROUTE_AUTH_BASE_PORT}` }]
      }
    };
    httpMiddlewares["lxc-auth-default"] = {
      forwardAuth: {
        address: `http://127.0.0.1:${ROUTE_AUTH_BASE_PORT}/`,
        trustForwardHeader: true,
        authResponseHeaders: ["X-Auth-Request-User", "X-Auth-Request-Email", "X-Auth-Request-Groups"]
      }
    };
    for (const profile of authProfiles.filter((profile) => profile.groups.length > 0)) {
      httpMiddlewares[profile.middlewareName] = {
        forwardAuth: {
          address: `http://127.0.0.1:${profile.port}/`,
          trustForwardHeader: true,
          authResponseHeaders: ["X-Auth-Request-User", "X-Auth-Request-Email", "X-Auth-Request-Groups"]
        }
      };
    }
  }

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
            tls: { certResolver: "letsencrypt" },
            ...(item.auth.enabled
              ? {
                  middlewares: [
                    authProfileByKey.get(item.auth.groups.join(","))?.middlewareName ?? "lxc-auth-default"
                  ]
                }
              : {})
          };
        } else {
          httpRouters[`${serviceName}-http`] = {
            entryPoints: ["web"],
            rule,
            service: serviceName,
            ...(item.auth.enabled
              ? {
                  middlewares: [
                    authProfileByKey.get(item.auth.groups.join(","))?.middlewareName ?? "lxc-auth-default"
                  ]
                }
              : {})
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
    authProfiles,
    errors
  };
}

export async function proxySyncCmd(configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  const config = loadConfig(configPath, PREFIX);
  const containers = await enrichInstanceState(await loadInstancesForProxySync());
  const { dynamicYaml, extraEntrypoints, ufwPorts, authProfiles, errors } = buildDynamicConfig(containers, config);
  const staticYaml = buildStaticConfig(config, extraEntrypoints);

  const staticChanged = writeIfChanged(STATIC_CONFIG_PATH, staticYaml);
  writeIfChanged(DYNAMIC_CONFIG_PATH, dynamicYaml);
  const ufwErrors = await syncUfw(ufwPorts);
  const routeAuthErrors = await syncRouteAuthStack(config, authProfiles);

  if (staticChanged) {
    await runText(["systemctl", "restart", "traefik"], PREFIX);
  }

  for (const error of [...errors, ...ufwErrors, ...routeAuthErrors]) {
    console.error(`${PREFIX}: ${error}`);
  }
}
