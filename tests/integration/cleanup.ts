import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { IntegrationContext } from "./context";
import { shellEscape } from "./lib/process";
import type { ManagedHost } from "./types";

const ROUTE_AUTH_DIR = "/var/lib/terrarium/oauth2-proxy-routes";
const ROUTE_AUTH_COMPOSE_PATH = `${ROUTE_AUTH_DIR}/docker-compose.yml`;

type HostDiagnostic = {
  name: string;
  command: string;
  timeoutMs: number;
};

function routeAuthComposeCommand(command: string): string {
  return `
if [ -f ${shellEscape(ROUTE_AUTH_COMPOSE_PATH)} ]; then
  ${command}
else
  echo "${ROUTE_AUTH_COMPOSE_PATH} is missing"
fi
`.trim();
}

function routeAuthProbeCommand(): string {
  return `
set +e
route_auth_dir=${shellEscape(ROUTE_AUTH_DIR)}
compose_file=${shellEscape(ROUTE_AUTH_COMPOSE_PATH)}
if [ -f "$compose_file" ]; then
  echo "== compose services =="
  timeout 15s docker compose -f "$compose_file" config --services 2>&1 || true
fi

shopt -s nullglob
configs=("$route_auth_dir"/*.cfg)
if [ "\${#configs[@]}" -eq 0 ]; then
  echo "no route-auth cfg files found in $route_auth_dir"
  exit 0
fi

for cfg in "\${configs[@]}"; do
  port=$(sed -nE 's/^[[:space:]]*http_address[[:space:]]*=[[:space:]]*"127\\.0\\.0\\.1:([0-9]+)".*/\\1/p' "$cfg" | head -n 1)
  redirect_url=$(sed -nE 's/^[[:space:]]*redirect_url[[:space:]]*=[[:space:]]*"([^"]+)".*/\\1/p' "$cfg" | head -n 1)
  allowed_groups=$(sed -nE 's/^[[:space:]]*allowed_groups[[:space:]]*=[[:space:]]*(.*)/\\1/p' "$cfg" | head -n 1)

  echo
  echo "== $(basename "$cfg") =="
  echo "redirect_url=\${redirect_url:-<missing>}"
  echo "allowed_groups=\${allowed_groups:-<none>}"
  if [ -z "$port" ]; then
    echo "http_address port missing"
    continue
  fi

  echo "port=$port"
  echo "-- listener socket --"
  timeout 5s ss -ltnp "sport = :$port" 2>&1
  echo "ss_exit=$?"
  echo "-- curl http://127.0.0.1:$port/ping --"
  timeout 8s curl -fsS --noproxy "*" --connect-timeout 2 --max-time 3 "http://127.0.0.1:$port/ping" 2>&1
  echo
  echo "curl_exit=$?"
done
`.trim();
}

function traefikRawdataCommand(host: ManagedHost): string {
  return `
set +e
proxy_domain=${shellEscape(host.domains.proxy)}
if [ -z "$proxy_domain" ]; then
  echo "proxy domain is missing from host metadata"
  exit 0
fi

for endpoint in /api/rawdata /api/http/routers /api/http/services /api/http/middlewares; do
  echo
  echo "== https://\${proxy_domain}\${endpoint} =="
  headers=$(mktemp)
  body=$(mktemp)
  curl_stderr=$(timeout 15s curl -ksS --noproxy "*" --connect-timeout 2 --max-time 10 --resolve "\${proxy_domain}:443:127.0.0.1" -D "$headers" -o "$body" "https://\${proxy_domain}\${endpoint}" 2>&1)
  curl_exit=$?

  if [ -n "$curl_stderr" ]; then
    echo "-- curl stderr --"
    printf '%s\\n' "$curl_stderr"
  fi

  echo "-- headers --"
  if [ -s "$headers" ]; then
    sed -E 's/^(set-cookie:)[[:space:]].*/\\1 <redacted>/I' "$headers" | head -c 20000
    echo
  else
    echo "<empty>"
  fi

  echo "-- body first 200000 bytes --"
  if [ -s "$body" ]; then
    head -c 200000 "$body"
    echo
  else
    echo "<empty>"
  fi

  echo "curl_exit=$curl_exit"
  rm -f "$headers" "$body"
done
`.trim();
}

function proxySyncCommand(): string {
  return `
set +e
if [ -x /usr/local/bin/terrariumctl ]; then
  ctl=/usr/local/bin/terrariumctl
else
  ctl=$(command -v terrariumctl || true)
fi

if [ -z "$ctl" ]; then
  echo "terrariumctl not found"
  exit 127
fi

timeout 120s "$ctl" proxy sync
`.trim();
}

function hostDiagnostics(host: ManagedHost): HostDiagnostic[] {
  return [
    {
      name: "route-auth-compose-ps",
      command: routeAuthComposeCommand(`timeout 20s docker compose -f ${shellEscape(ROUTE_AUTH_COMPOSE_PATH)} ps --all`),
      timeoutMs: 30000
    },
    {
      name: "route-auth-compose-logs",
      command: routeAuthComposeCommand(`timeout 45s docker compose -f ${shellEscape(ROUTE_AUTH_COMPOSE_PATH)} logs --no-color --tail=200`),
      timeoutMs: 60000
    },
    {
      name: "route-auth-listener-probes",
      command: routeAuthProbeCommand(),
      timeoutMs: 45000
    },
    {
      name: "traefik-api-rawdata",
      command: traefikRawdataCommand(host),
      timeoutMs: 80000
    },
    {
      name: "systemctl-status",
      command:
        "timeout 30s systemctl status --no-pager --full --lines=80 terrarium-traefik-sync.service terrarium-traefik-sync.timer traefik terrarium-oauth2-proxy.service docker.service containerd.service",
      timeoutMs: 40000
    },
    {
      name: "journal",
      command:
        "timeout 45s journalctl -u traefik -u terrarium-oauth2-proxy.service -u terrarium-zitadel.service -u terrarium-traefik-sync.service -u terrarium-traefik-sync.timer -u terrarium-s3-backup.service -u terrarium-syncoid.service -u docker.service -u containerd.service --no-pager -n 500",
      timeoutMs: 60000
    },
    {
      name: "proxy-sync",
      command: proxySyncCommand(),
      timeoutMs: 150000
    }
  ];
}

function renderCommandArtifact(command: string, result: { exitCode: number; stdout: string; stderr: string }): string {
  return [
    `command:\n${command.trim()}`,
    `exitCode: ${result.exitCode}`,
    `stdout:\n${result.stdout.trim() || "<empty>"}`,
    `stderr:\n${result.stderr.trim() || "<empty>"}`
  ].join("\n\n") + "\n";
}

function renderCollectionError(command: string, error: unknown): string {
  return [
    `command:\n${command.trim()}`,
    "collection error:",
    error instanceof Error ? error.stack || error.message : String(error)
  ].join("\n\n") + "\n";
}

async function writeDiagnostic(context: IntegrationContext, host: ManagedHost, diagnostic: HostDiagnostic): Promise<void> {
  const ssh = context.ssh(host);
  const outputPath = join(context.localArtifactsDir, `${host.label}-${diagnostic.name}.log`);
  try {
    const result = await ssh.execAllowFailure(diagnostic.command, { timeoutMs: diagnostic.timeoutMs });
    await Bun.write(outputPath, renderCommandArtifact(diagnostic.command, result));
  } catch (error) {
    await Bun.write(outputPath, renderCollectionError(diagnostic.command, error));
  }
}

/** Collects a compact but high-value artifact bundle from a managed host. */
export async function collectHostArtifacts(context: IntegrationContext, host: ManagedHost): Promise<void> {
  const ssh = context.ssh(host);
  const outputPath = join(context.localArtifactsDir, `${host.label}.tar.gz`);
  mkdirSync(context.localArtifactsDir, { recursive: true });
  try {
    await ssh.archive(
      [
        "/etc/terrarium",
        "/etc/traefik",
        "/var/lib/terrarium",
        "/var/log",
        "/etc/systemd/system/terrarium*",
        "/etc/systemd/system/traefik.service"
      ],
      outputPath
    );
  } catch (error) {
    await Bun.write(join(context.localArtifactsDir, `${host.label}-archive-error.log`), String(error) + "\n");
  }

  for (const diagnostic of hostDiagnostics(host)) {
    await writeDiagnostic(context, host, diagnostic);
  }
}
