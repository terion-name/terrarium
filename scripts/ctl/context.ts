import chalk from "chalk";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { configString, loadConfig } from "../lib/common";

/** Shared command prefix used in CLI error messages and subprocess output. */
export const PREFIX = "terrariumctl";

/** Canonical persisted Terrarium config path on managed hosts. */
export const CONFIG_PATH = process.env.TERRARIUM_CONFIG_PATH ?? "/etc/terrarium/config.yaml";

/** System fstab path used by the managed host-mount subsystem. */
export const FSTAB_PATH = "/etc/fstab";

/** Directory that stores Terrarium-managed mount credentials. */
export const MOUNTS_DIR = "/etc/terrarium/mounts";

/** Prefix for Terrarium-owned fstab blocks so they can be listed and removed safely. */
export const MOUNT_MARKER_PREFIX = "TERRARIUM MOUNT ";

/** Generic mutable YAML-backed config object used across the CLI. */
export type MutableConfig = Record<string, unknown>;

/** Parsed representation of one Terrarium-managed host mount from `/etc/fstab`. */
export type ManagedMount = {
  marker: string;
  address: string;
  hostPath: string;
  protocol: string;
  options: string[];
  credentialsPath: string;
};

/**
 * Normalizes argv for the compiled binary and source-run modes.
 *
 * Bun and direct script execution can shift the expected executable slot,
 * so this helper ensures `cac` always sees a stable binary name.
 */
export function normalizedArgv(rawArgv: string[]): string[] {
  if (rawArgv.length < 2) {
    return ["terrariumctl", "terrariumctl"];
  }

  const second = rawArgv[1] ?? "";
  const looksLikeScriptPath =
    second.includes("/") || second.endsWith(".ts") || second.endsWith(".js") || second.includes("terrariumctl");

  if (looksLikeScriptPath) {
    return rawArgv;
  }

  return [rawArgv[0] ?? "terrariumctl", "terrariumctl", ...rawArgv.slice(1)];
}

/** Renders a bold section heading for human-readable CLI output. */
export function heading(text: string): string {
  return chalk.bold(text);
}

/** Renders a cyan label for human-readable CLI output. */
export function label(text: string): string {
  return chalk.cyan(text);
}

/** Renders a plain value string for human-readable CLI output. */
export function value(text: string): string {
  return chalk.white(text);
}

/** Renders a success message with green emphasis. */
export function success(text: string): string {
  return chalk.green(text);
}

/**
 * Loads the persisted Terrarium config and fails fast when it is missing.
 *
 * Most operational commands require a fully installed host, so this acts as a
 * guardrail against running stateful commands before install has completed.
 */
export function requireConfig(): MutableConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`config not found: ${CONFIG_PATH}`);
  }
  return loadConfig(CONFIG_PATH, PREFIX);
}

/** Loads the mutable YAML config document so callers can update and re-write it. */
export function loadMutableConfig(): MutableConfig {
  return parse(readFileSync(CONFIG_PATH, "utf8")) as MutableConfig;
}

/** Returns the configured OIDC issuer URL, or an empty string when unset. */
export function oidcIssuer(config: MutableConfig): string {
  return configString(config, "terrarium_oidc_issuer");
}

/** Returns the configured IDP mode, defaulting to external OIDC semantics. */
export function idpMode(config: MutableConfig): string {
  return configString(config, "terrarium_idp_mode", "oidc");
}

/** Returns whether any IDP integration is enabled for the host. */
export function idpEnabled(config: MutableConfig): boolean {
  return ["local", "oidc"].includes(idpMode(config));
}

/** Returns whether Terrarium is currently using self-hosted ZITADEL mode. */
export function localIdpEnabled(config: MutableConfig): boolean {
  return idpMode(config) === "local";
}

/** Resolves the effective Terrarium admin group with a sensible local-IDP default. */
export function adminGroup(config: MutableConfig): string {
  return configString(config, "terrarium_admin_group", localIdpEnabled(config) ? "terrarium-admins" : "");
}

/**
 * Derives a service domain from the configured root domain or public IP.
 *
 * This centralizes the installer/runtime fallback behavior so commands and
 * status output always agree on the effective service hostname.
 */
export function defaultServiceDomain(rootDomain: string, publicIp: string, prefix: string): string {
  const dashed = publicIp.replaceAll(".", "-");
  return rootDomain ? `${prefix}.${rootDomain}` : `${prefix}.${dashed}.traefik.me`;
}

/** Mutates a YAML-backed config object in place. */
export function setConfigValue(config: MutableConfig, key: string, nextValue: unknown): void {
  config[key] = nextValue;
}

/**
 * Reads a string CLI option from a parsed `cac` options object.
 *
 * The helper accepts aliases because `cac` preserves both camelCase and raw
 * dashed spellings in different situations.
 */
export function cliOption(options: Record<string, unknown>, key: string, aliases: string[] = []): string | undefined {
  for (const candidate of [key, ...aliases]) {
    const nextValue = options[candidate];
    if (typeof nextValue === "string") {
      return nextValue;
    }
  }
  return undefined;
}

/**
 * Parses an explicit boolean CLI option such as `--seal true|false`.
 *
 * The command surface intentionally uses a typed boolean instead of negated
 * flags so the generated help stays readable and the default is explicit.
 */
export function parseBooleanOption(value: string | undefined, optionName: string, defaultValue: boolean): boolean {
  if (value === undefined || value === "") {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${optionName} must be true or false`);
}
