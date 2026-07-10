import chalk from "chalk";
import { parse } from "yaml";
import { configString, loadConfig } from "../lib/common";
import {
  configStoreSummary,
  DEFAULT_CONFIG_PATH,
  hasConfigDocument,
  readConfigDocument,
  writeConfigDocument
} from "../lib/config-store";
import {
  resolveEffectiveIdpProvider,
  resolveLocalIdpOutputsPath,
  resolveLxdOidcGroupsClaim,
  resolveLxdOidcScopes,
  resolveOidcGroupsClaim,
  resolveOidcScopes,
  type EffectiveIdpProvider
} from "../lib/idp-provider";

/** Shared command prefix used in CLI error messages and subprocess output. */
export const PREFIX = "terrariumctl";

/** Canonical persisted Terrarium config path on managed hosts. */
export const CONFIG_PATH = process.env.TERRARIUM_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;

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
  return loadConfig(CONFIG_PATH, PREFIX);
}

/** Loads the mutable YAML config document so callers can update and re-write it. */
export function loadMutableConfig(): MutableConfig {
  return parse(readConfigDocument(CONFIG_PATH, PREFIX)) as MutableConfig;
}

/** Persists the mutable config to the cluster-backed store. */
export function saveMutableConfig(content: string): void {
  writeConfigDocument(CONFIG_PATH, content, { requireClusterStore: true });
}

/** Returns whether Terrarium has a saved config in the active store or legacy export. */
export function savedConfigExists(): boolean {
  return hasConfigDocument(CONFIG_PATH, PREFIX);
}

/** Returns the active config storage backend for human-readable status output. */
export function activeConfigStore(): string {
  return configStoreSummary(CONFIG_PATH);
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

/** Returns the explicitly persisted IDP provider, or an empty string when unset. */
export function idpProvider(config: MutableConfig): string {
  const provider = config["terrarium_idp_provider"];
  return typeof provider === "string" ? provider.trim() : "";
}

/** Resolves the active IDP provider, including implicit local/external defaults. */
export function effectiveIdpProvider(config: MutableConfig): EffectiveIdpProvider {
  return resolveEffectiveIdpProvider(idpMode(config), idpProvider(config));
}

/** Returns the management OIDC groups claim for the effective provider. */
export function oidcGroupsClaim(config: MutableConfig): string {
  return resolveOidcGroupsClaim(config, effectiveIdpProvider(config));
}

/** Returns the management OIDC scopes for the effective provider. */
export function oidcScopes(config: MutableConfig): string {
  return resolveOidcScopes(config, effectiveIdpProvider(config));
}

/** Returns the LXD OIDC groups claim for the effective provider. */
export function lxdOidcGroupsClaim(config: MutableConfig): string {
  return resolveLxdOidcGroupsClaim(config, effectiveIdpProvider(config));
}

/** Returns the LXD OIDC scopes for the effective provider. */
export function lxdOidcScopes(config: MutableConfig): string {
  return resolveLxdOidcScopes(config, effectiveIdpProvider(config));
}

/** Returns the local IDP output file path, including legacy ZITADEL fallback. */
export function localIdpOutputsPath(config: MutableConfig): string {
  return resolveLocalIdpOutputsPath(config);
}

/** Returns whether Terrarium is currently using self-hosted IDP mode. */
export function localIdpEnabled(config: MutableConfig): boolean {
  return idpMode(config) === "local";
}

/** Returns whether Terrarium is using the self-hosted ZITADEL provider. */
export function localZitadelEnabled(config: MutableConfig): boolean {
  return localIdpEnabled(config) && effectiveIdpProvider(config) === "zitadel";
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
  const candidates = [key, ...aliases];
  for (const candidate of candidates) {
    const nextValue = options[candidate];
    if (typeof nextValue === "string") {
      return nextValue;
    }
    if (typeof nextValue === "number") {
      return rawCliOption(candidates) ?? String(nextValue);
    }
  }
  return undefined;
}

function rawCliOption(names: string[]): string | undefined {
  const longNames = new Set(names.map((name) => `--${name}`));
  const argv = process.argv;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (longNames.has(arg)) {
      return argv[index + 1];
    }
    for (const longName of longNames) {
      if (arg.startsWith(`${longName}=`)) {
        return arg.slice(longName.length + 1);
      }
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
