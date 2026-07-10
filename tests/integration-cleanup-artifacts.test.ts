import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

describe("integration cleanup artifacts", () => {
  test("collects main oauth2-proxy compose and listener diagnostics", () => {
    const cleanupSource = readFileSync(join(import.meta.dir, "integration/cleanup.ts"), "utf8");

    expect(cleanupSource).toContain('MAIN_OAUTH2_PROXY_DIR = "/var/lib/terrarium/oauth2-proxy"');
    expect(cleanupSource).toContain('MAIN_OAUTH2_PROXY_COMPOSE_PROJECT = "terrarium-oauth2-proxy"');
    expect(cleanupSource).toContain("MAIN_OAUTH2_PROXY_COMPOSE_PATH");
    expect(cleanupSource).toContain('name: "oauth2-proxy-compose-ps"');
    expect(cleanupSource).toContain('name: "oauth2-proxy-compose-logs"');
    expect(cleanupSource).toContain('name: "oauth2-proxy-listener-probe"');
    expect(cleanupSource).toContain(
      "docker compose --project-name ${shellEscape(MAIN_OAUTH2_PROXY_COMPOSE_PROJECT)} -f ${shellEscape(MAIN_OAUTH2_PROXY_COMPOSE_PATH)} ps --all"
    );
    expect(cleanupSource).toContain(
      "docker compose --project-name ${shellEscape(MAIN_OAUTH2_PROXY_COMPOSE_PROJECT)} -f ${shellEscape(MAIN_OAUTH2_PROXY_COMPOSE_PATH)} logs --no-color --tail=200"
    );
    expect(cleanupSource).toContain('port=4180');
    expect(cleanupSource).toContain('ss -ltnp "sport = :$port"');
    expect(cleanupSource).toContain('http://127.0.0.1:$port/ping');
  });

  test("collects Logto system instance service and compose diagnostics", () => {
    const cleanupSource = readFileSync(join(import.meta.dir, "integration/cleanup.ts"), "utf8");

    expect(cleanupSource).toContain('LOGTO_INSTANCE_NAME = "terrarium-idp"');
    expect(cleanupSource).toContain('LOGTO_DIR = "/var/lib/terrarium/logto"');
    expect(cleanupSource).toContain('LOGTO_COMPOSE_PROJECT = "terrarium-logto"');
    expect(cleanupSource).toContain("LOGTO_COMPOSE_PATH");
    expect(cleanupSource).toContain('name: "logto-systemctl-status"');
    expect(cleanupSource).toContain('name: "logto-journal"');
    expect(cleanupSource).toContain('name: "logto-compose-ps"');
    expect(cleanupSource).toContain('name: "logto-compose-logs"');
    expect(cleanupSource).toContain('name: "logto-config-summary"');
    expect(cleanupSource).toContain("systemctl status --no-pager --full --lines=120 terrarium-logto.service docker.service");
    expect(cleanupSource).toContain("journalctl -u terrarium-logto.service -u docker.service --no-pager -n 500");
    expect(cleanupSource).toContain(
      "docker compose --project-name ${shellEscape(LOGTO_COMPOSE_PROJECT)} -f ${shellEscape(LOGTO_COMPOSE_PATH)} ps --all"
    );
    expect(cleanupSource).toContain(
      "docker compose --project-name ${shellEscape(LOGTO_COMPOSE_PROJECT)} -f ${shellEscape(LOGTO_COMPOSE_PATH)} logs --no-color --tail=300"
    );
  });
});
