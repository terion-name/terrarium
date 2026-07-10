import { input } from "@inquirer/prompts";
import { stringify } from "yaml";
import { normalizeOidcIssuer, validateEmail, validateLogtoAdminUsername } from "../terrarium-install";
import {
  cliOption,
  CONFIG_PATH,
  defaultServiceDomain,
  effectiveIdpProvider,
  loadMutableConfig,
  localIdpEnabled,
  localIdpOutputsPath,
  localZitadelEnabled,
  MutableConfig,
  saveMutableConfig,
  setConfigValue,
  success
} from "./context";
import { configBoolean, configString, normalizeS3Endpoint } from "../lib/common";
import { existsSync, readFileSync } from "node:fs";
import { verifyOidcConfig, verifyS3Config, type OidcVerificationOptions } from "./verify";
import { exportClusterStoreToConfigFile, importConfigFileToClusterStore } from "../lib/config-store";
import { resolveLocalOidcIssuer, validatePublicIdpProvider } from "../lib/idp-provider";

/** Callback bundle used after any saved config change that affects the running host. */
export type ReconcileActions = {
  reconfigure: () => Promise<void>;
  syncProxy: () => Promise<void>;
  syncIdp: () => Promise<void>;
  readLocalIdpOutputs?: () => Promise<string> | string;
};

/** Reusable option bag for `set domains`. */
export type SetDomainsOptions = {
  manageDomain?: string;
  proxyDomain?: string;
  lxdDomain?: string;
  authDomain?: string;
};

/** Reusable option bag for `set emails`. */
export type SetEmailsOptions = {
  email?: string;
  acmeEmail?: string;
  zitadelAdminEmail?: string;
  logtoAdminEmail?: string;
};

/** Reusable option bag for `set idp`. */
export type SetIdpOptions = {
  mode: string;
  provider?: string;
  adminGroup?: string;
  authDomain?: string;
  oidc?: string;
  oidcClient?: string;
  oidcSecret?: string;
  oidcSecretFile?: string;
  lxdOidcClient?: string;
  lxdOidcSecret?: string;
  lxdOidcSecretFile?: string;
  oidcGroupsClaim?: string;
  oidcScopes?: string;
  lxdOidcGroupsClaim?: string;
  lxdOidcScopes?: string;
  localIdpOutputsPath?: string;
  zitadelAdminEmail?: string;
  logtoAdminEmail?: string;
  logtoAdminUsername?: string;
};

/** Reusable option bag for `set s3`. */
export type SetS3Options = {
  enable?: boolean;
  disable?: boolean;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3Region?: string;
  s3Prefix?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  s3SecretKeyFile?: string;
};

/** Reusable option bag for `set syncoid`. */
export type SetSyncoidOptions = {
  enable?: boolean;
  disable?: boolean;
  syncoidTarget?: string;
  syncoidTargetDataset?: string;
  syncoidSshKey?: string;
};

/** Reusable option bag for `set dns provider`. */
export type SetDnsProviderOptions = {
  provider?: string;
  credentials: string[];
};

type SetIdpPlan = {
  summary: string;
  verifyOidc?: OidcVerificationOptions;
};

function secretCliOption(
  rawOptions: Record<string, unknown>,
  key: string,
  fileKey: string,
  aliases: string[] = [],
  fileAliases: string[] = []
): string | undefined {
  const inlineValue = cliOption(rawOptions, key, aliases);
  const filePath = cliOption(rawOptions, fileKey, fileAliases);
  if (inlineValue && filePath) {
    throw new Error(`use only one of --${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} or --${fileKey.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`);
  }
  if (!filePath) {
    return inlineValue || undefined;
  }
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch (error) {
    throw new Error(`failed to read secret file ${filePath}: ${String(error).replace(/^Error: /, "")}`);
  }
}

/**
 * Writes a config document and converges the live host to match it.
 *
 * Every `set ...` command should go through this helper so the saved config
 * and the actual host state never drift for long.
 */
async function readLocalIdpOutputs(config: MutableConfig, actions: ReconcileActions): Promise<string> {
  if (actions.readLocalIdpOutputs) {
    return await actions.readLocalIdpOutputs();
  }
  const outputsPath = localIdpOutputsPath(config);
  if (!existsSync(outputsPath)) {
    return "";
  }
  return readFileSync(outputsPath, "utf8");
}

export async function runReconcileActions(config: MutableConfig, actions: ReconcileActions): Promise<void> {
  await actions.reconfigure();
  if (localZitadelEnabled(config)) {
    let stable = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const outputsBeforeSync = await readLocalIdpOutputs(config, actions);
      await actions.syncIdp();
      const outputsAfterSync = await readLocalIdpOutputs(config, actions);
      if (outputsAfterSync === outputsBeforeSync) {
        stable = true;
        break;
      }
      await actions.reconfigure();
    }
    if (!stable) {
      throw new Error("local IDP outputs kept changing after reconciliation; refusing to continue with stale OAuth client configuration");
    }
  }
  await actions.syncProxy();
}

async function persistAndReconcile(config: MutableConfig, summary: string, actions: ReconcileActions): Promise<void> {
  saveMutableConfig(stringify(config));
  await runReconcileActions(config, actions);
  console.log(success(summary));
}

function validateLegoDnsProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
    throw new Error("DNS provider must be a lego provider code such as cloudflare, hetzner, route53, or acme-dns");
  }
  return normalized;
}

function parseDnsCredentials(credentials: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const credential of credentials) {
    const separator = credential.indexOf(":");
    if (separator <= 0) {
      throw new Error(`DNS credential must use KEY:VALUE form: ${credential}`);
    }
    const key = credential.slice(0, separator);
    const value = credential.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error(`DNS credential key must be an uppercase lego environment variable name: ${key}`);
    }
    if (/[\r\n]/.test(value)) {
      throw new Error(`DNS credential value for ${key} must be a single line`);
    }
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

/** Enables or disables Traefik DNS-01 ACME using lego provider env names. */
export function applySetDnsProviderConfig(config: MutableConfig, options: SetDnsProviderOptions): string {
  const provider = validateLegoDnsProvider(options.provider ?? "");
  if (!provider) {
    setConfigValue(config, "terrarium_acme_dns_provider", "");
    setConfigValue(config, "terrarium_acme_dns_env", {});
    return "Disabled DNS-01 ACME";
  }

  setConfigValue(config, "terrarium_acme_dns_provider", provider);
  setConfigValue(config, "terrarium_acme_dns_env", parseDnsCredentials(options.credentials));
  return `Enabled DNS-01 ACME provider ${provider}`;
}

export async function setDnsProviderCmd(options: SetDnsProviderOptions, actions: ReconcileActions): Promise<void> {
  const config = loadMutableConfig();
  const summary = applySetDnsProviderConfig(config, options);
  await persistAndReconcile(config, summary, actions);
}

/** Imports the local YAML export into the dqlite-backed LXD project store. */
export function configImportCmd(): void {
  importConfigFileToClusterStore(CONFIG_PATH, "terrariumctl config import");
  console.log(success("Imported config into the LXD dqlite store"));
}

/** Recreates the local YAML export from the dqlite-backed LXD project store. */
export function configExportCmd(): void {
  if (!exportClusterStoreToConfigFile(CONFIG_PATH, "terrariumctl config export")) {
    throw new Error("Terrarium config was not found in the LXD dqlite store");
  }
  console.log(success(`Exported config to ${CONFIG_PATH}`));
}

/** Updates Terrarium’s management and public domains, then converges the host. */
export async function setDomainsCmd(
  rootDomainArg: string | undefined,
  options: SetDomainsOptions,
  actions: ReconcileActions,
  confirmDestructive: (message: string) => Promise<void>
): Promise<void> {
  const config = loadMutableConfig();
  const publicIp = configString(config, "terrarium_public_ip");
  const rootDomain =
    rootDomainArg ||
    (await input({
      message: "Root domain",
      default: configString(config, "terrarium_root_domain"),
      validate: (value) => (value.trim() ? true : "Root domain is required")
    }));

  setConfigValue(config, "terrarium_root_domain", rootDomain);
  setConfigValue(config, "terrarium_manage_domain", options.manageDomain || defaultServiceDomain(rootDomain, publicIp, "manage"));
  setConfigValue(config, "terrarium_proxy_domain", options.proxyDomain || defaultServiceDomain(rootDomain, publicIp, "proxy"));
  setConfigValue(config, "terrarium_lxd_domain", options.lxdDomain || defaultServiceDomain(rootDomain, publicIp, "lxd"));
  if (localIdpEnabled(config)) {
    const authDomain = options.authDomain || defaultServiceDomain(rootDomain, publicIp, "auth");
    const issuer = resolveLocalOidcIssuer(authDomain, effectiveIdpProvider(config));
    setConfigValue(config, "terrarium_auth_domain", authDomain);
    setConfigValue(config, "terrarium_oidc_issuer", normalizeOidcIssuer(issuer, "--oidc"));
  }

  if (!localIdpEnabled(config)) {
    const verification = await verifyOidcConfig({
      issuer: configString(config, "terrarium_oidc_issuer"),
      clientId: configString(config, "terrarium_oidc_client_id"),
      clientSecret: configString(config, "terrarium_oidc_client_secret"),
      lxdClientId: configString(config, "terrarium_lxd_oidc_client_id") || configString(config, "terrarium_oidc_client_id"),
      lxdClientSecret: configString(config, "terrarium_lxd_oidc_client_secret"),
      manageDomain: configString(config, "terrarium_manage_domain"),
      proxyDomain: configString(config, "terrarium_proxy_domain"),
      lxdDomain: configString(config, "terrarium_lxd_domain")
    });
    setConfigValue(config, "terrarium_oidc_issuer", verification.issuer);
  }

  await confirmDestructive(
    `Apply domains: manage=${String(config.terrarium_manage_domain)}, proxy=${String(config.terrarium_proxy_domain)}, lxd=${String(config.terrarium_lxd_domain)}${
      config.terrarium_auth_domain ? `, auth=${String(config.terrarium_auth_domain)}` : ""
    }?`
  );

  await persistAndReconcile(config, "Updated domains", actions);
}

/** Updates Terrarium contact, certificate, and local-IDP email settings. */
export async function setEmailsCmd(options: SetEmailsOptions, actions: ReconcileActions): Promise<void> {
  const config = loadMutableConfig();
  if (!options.email && !options.acmeEmail && !options.zitadelAdminEmail && !options.logtoAdminEmail) {
    throw new Error("set emails requires at least one of --email, --acme-email, --zitadel-admin-email, or --logto-admin-email");
  }
  if (options.email) {
    setConfigValue(config, "terrarium_email", validateEmail(options.email, "--email"));
  }
  if (options.acmeEmail) {
    setConfigValue(config, "terrarium_acme_email", validateEmail(options.acmeEmail, "--acme-email"));
  } else if (!configString(config, "terrarium_acme_email")) {
    setConfigValue(config, "terrarium_acme_email", configString(config, "terrarium_email"));
  }
  if (options.zitadelAdminEmail) {
    setConfigValue(config, "terrarium_zitadel_admin_email", validateEmail(options.zitadelAdminEmail, "--zitadel-admin-email"));
  }
  if (options.logtoAdminEmail) {
    setConfigValue(config, "terrarium_logto_admin_email", validateEmail(options.logtoAdminEmail, "--logto-admin-email"));
  }

  await persistAndReconcile(config, "Updated email settings", actions);
}

/** Switches between self-hosted ZITADEL and external OIDC management auth modes. */
export function applySetIdpConfig(config: MutableConfig, options: SetIdpOptions): SetIdpPlan {
  const publicIp = configString(config, "terrarium_public_ip");
  const rootDomain = configString(config, "terrarium_root_domain");
  const nextMode = options.mode.trim().toLowerCase();
  if (!["local", "oidc"].includes(nextMode)) {
    throw new Error("set idp requires mode 'local' or 'oidc'");
  }
  const explicitProvider = options.provider === undefined ? undefined : validatePublicIdpProvider(options.provider);

  setConfigValue(config, "terrarium_idp_mode", nextMode);
  if (explicitProvider !== undefined) setConfigValue(config, "terrarium_idp_provider", explicitProvider);
  if (options.oidcGroupsClaim !== undefined) setConfigValue(config, "terrarium_oidc_groups_claim", options.oidcGroupsClaim);
  if (options.oidcScopes !== undefined) setConfigValue(config, "terrarium_oidc_scopes", options.oidcScopes);
  if (options.lxdOidcGroupsClaim !== undefined) setConfigValue(config, "terrarium_lxd_oidc_groups_claim", options.lxdOidcGroupsClaim);
  if (options.lxdOidcScopes !== undefined) setConfigValue(config, "terrarium_lxd_oidc_scopes", options.lxdOidcScopes);
  if (options.localIdpOutputsPath !== undefined) setConfigValue(config, "terrarium_local_idp_outputs_path", options.localIdpOutputsPath);

  if (nextMode === "local") {
    const nextAdminGroup = options.adminGroup || configString(config, "terrarium_admin_group") || "terrarium-admins";
    const authDomain = options.authDomain || configString(config, "terrarium_auth_domain") || defaultServiceDomain(rootDomain, publicIp, "auth");
    setConfigValue(config, "terrarium_admin_group", nextAdminGroup);
    const issuer = resolveLocalOidcIssuer(authDomain, effectiveIdpProvider(config));
    setConfigValue(config, "terrarium_auth_domain", authDomain);
    setConfigValue(config, "terrarium_oidc_issuer", normalizeOidcIssuer(issuer, "--oidc"));
    setConfigValue(config, "terrarium_oidc_client_id", "");
    setConfigValue(config, "terrarium_oidc_client_secret", "");
    setConfigValue(config, "terrarium_lxd_oidc_client_id", "");
    setConfigValue(config, "terrarium_lxd_oidc_client_secret", "");
    if (localZitadelEnabled(config)) {
      const currentAdmin = options.zitadelAdminEmail || configString(config, "terrarium_zitadel_admin_email") || configString(config, "terrarium_email");
      setConfigValue(config, "terrarium_zitadel_admin_email", validateEmail(currentAdmin, "--zitadel-admin-email"));
    } else if (effectiveIdpProvider(config) === "logto") {
      const currentEmail = options.logtoAdminEmail || configString(config, "terrarium_logto_admin_email") || configString(config, "terrarium_email");
      const currentUsername = options.logtoAdminUsername || configString(config, "terrarium_logto_admin_username") || "terrarium_admin";
      setConfigValue(config, "terrarium_logto_admin_email", validateEmail(currentEmail, "--logto-admin-email"));
      setConfigValue(config, "terrarium_logto_admin_username", validateLogtoAdminUsername(currentUsername, "--logto-admin-username"));
    }
    return { summary: "Switched IDP mode to local" };
  } else {
    const issuer = options.oidc || configString(config, "terrarium_oidc_issuer");
    const nextAdminGroup = options.adminGroup || configString(config, "terrarium_admin_group");
    if (!issuer) {
      throw new Error("--oidc is required when mode is oidc");
    }
    if (!nextAdminGroup) {
      throw new Error("--admin-group is required when mode is oidc");
    }
    const clientId = options.oidcClient || configString(config, "terrarium_oidc_client_id");
    const clientSecret = options.oidcSecret || configString(config, "terrarium_oidc_client_secret");
    if (!clientId) {
      throw new Error("--oidc-client is required when mode is oidc");
    }
    if (!clientSecret) {
      throw new Error("--oidc-secret is required when mode is oidc");
    }
    const lxdClientId = options.lxdOidcClient || configString(config, "terrarium_lxd_oidc_client_id") || clientId;
    const existingLxdSecret = configString(config, "terrarium_lxd_oidc_client_secret");
    const lxdClientSecret =
      options.lxdOidcSecret ||
      (options.lxdOidcClient && options.lxdOidcClient !== clientId ? "" : existingLxdSecret || (lxdClientId === clientId ? clientSecret : ""));
    if (options.authDomain) {
      setConfigValue(config, "terrarium_auth_domain", options.authDomain);
    }
    setConfigValue(config, "terrarium_admin_group", nextAdminGroup);
    setConfigValue(config, "terrarium_oidc_issuer", normalizeOidcIssuer(issuer, "--oidc"));
    setConfigValue(config, "terrarium_oidc_client_id", clientId);
    setConfigValue(config, "terrarium_oidc_client_secret", clientSecret);
    setConfigValue(config, "terrarium_lxd_oidc_client_id", lxdClientId === clientId ? "" : lxdClientId);
    setConfigValue(config, "terrarium_lxd_oidc_client_secret", lxdClientId === clientId && lxdClientSecret === clientSecret ? "" : lxdClientSecret);
    return {
      summary: "Switched IDP mode to oidc",
      verifyOidc: {
        issuer: configString(config, "terrarium_oidc_issuer"),
        clientId: configString(config, "terrarium_oidc_client_id"),
        clientSecret: configString(config, "terrarium_oidc_client_secret"),
        lxdClientId,
        lxdClientSecret,
        manageDomain: configString(config, "terrarium_manage_domain"),
        proxyDomain: configString(config, "terrarium_proxy_domain"),
        lxdDomain: configString(config, "terrarium_lxd_domain")
      }
    };
  }
}

export async function setIdpCmd(options: SetIdpOptions, actions: ReconcileActions): Promise<void> {
  const config = loadMutableConfig();
  const plan = applySetIdpConfig(config, options);
  if (plan.verifyOidc) {
    const verification = await verifyOidcConfig(plan.verifyOidc);
    setConfigValue(config, "terrarium_oidc_issuer", verification.issuer);
  }
  await persistAndReconcile(config, plan.summary, actions);
}

/** Updates or disables S3 backup export settings. */
export async function setS3Cmd(options: SetS3Options, actions: ReconcileActions): Promise<void> {
  const config = loadMutableConfig();
  if (options.enable && options.disable) {
    throw new Error("set s3 accepts only one of --enable or --disable");
  }
  const nextEnabled = options.enable ? true : options.disable ? false : configBoolean(config, "terrarium_enable_s3");
  setConfigValue(config, "terrarium_enable_s3", nextEnabled);

  if (options.s3Endpoint !== undefined) setConfigValue(config, "terrarium_s3_endpoint", normalizeS3Endpoint(options.s3Endpoint));
  if (options.s3Bucket !== undefined) setConfigValue(config, "terrarium_s3_bucket", options.s3Bucket);
  if (options.s3Region !== undefined) setConfigValue(config, "terrarium_s3_region", options.s3Region);
  if (options.s3Prefix !== undefined) setConfigValue(config, "terrarium_s3_prefix", options.s3Prefix);
  if (options.s3AccessKey !== undefined) setConfigValue(config, "terrarium_s3_access_key", options.s3AccessKey);
  if (options.s3SecretKey !== undefined) setConfigValue(config, "terrarium_s3_secret_key", options.s3SecretKey);

  if (nextEnabled) {
    if (!configString(config, "terrarium_s3_bucket")) throw new Error("S3 requires --s3-bucket");
    if (!configString(config, "terrarium_s3_access_key")) throw new Error("S3 requires --s3-access-key");
    if (!configString(config, "terrarium_s3_secret_key")) throw new Error("S3 requires --s3-secret-key");
    if (!configString(config, "terrarium_s3_prefix")) setConfigValue(config, "terrarium_s3_prefix", "terrarium");
    await verifyS3Config({
      endpoint: configString(config, "terrarium_s3_endpoint"),
      bucket: configString(config, "terrarium_s3_bucket"),
      region: configString(config, "terrarium_s3_region", "us-east-1"),
      prefix: configString(config, "terrarium_s3_prefix", "terrarium"),
      accessKey: configString(config, "terrarium_s3_access_key"),
      secretKey: configString(config, "terrarium_s3_secret_key")
    });
  }

  await persistAndReconcile(config, nextEnabled ? "Updated S3 settings" : "Disabled S3 backups", actions);
}

/** Updates or disables syncoid replication settings. */
export async function setSyncoidCmd(options: SetSyncoidOptions, actions: ReconcileActions): Promise<void> {
  const config = loadMutableConfig();
  if (options.enable && options.disable) {
    throw new Error("set syncoid accepts only one of --enable or --disable");
  }
  const nextEnabled = options.enable ? true : options.disable ? false : configBoolean(config, "terrarium_enable_syncoid");
  setConfigValue(config, "terrarium_enable_syncoid", nextEnabled);

  if (options.syncoidTarget !== undefined) setConfigValue(config, "terrarium_syncoid_target", options.syncoidTarget);
  if (options.syncoidTargetDataset !== undefined) setConfigValue(config, "terrarium_syncoid_target_dataset", options.syncoidTargetDataset);
  if (options.syncoidSshKey !== undefined) setConfigValue(config, "terrarium_syncoid_ssh_key", options.syncoidSshKey);

  if (nextEnabled) {
    if (!configString(config, "terrarium_syncoid_target")) throw new Error("syncoid requires --syncoid-target");
    if (!configString(config, "terrarium_syncoid_target_dataset")) throw new Error("syncoid requires --syncoid-target-dataset");
    if (!configString(config, "terrarium_syncoid_ssh_key")) {
      setConfigValue(config, "terrarium_syncoid_ssh_key", "/root/.ssh/id_ed25519");
    }
  }

  await persistAndReconcile(config, nextEnabled ? "Updated syncoid settings" : "Disabled syncoid replication", actions);
}

/**
 * Extracts and normalizes `set ...` options from the raw `cac` option object.
 *
 * The main CLI file uses this helper so command wiring stays declarative while
 * still handling the camelCase/dashed alias quirks from `cac`.
 */
export function parseSetCommandOptions(rawOptions: Record<string, unknown>) {
  return {
    domains: {
      manageDomain: cliOption(rawOptions, "manageDomain", ["manage-domain"]),
      proxyDomain: cliOption(rawOptions, "proxyDomain", ["proxy-domain"]),
      lxdDomain: cliOption(rawOptions, "lxdDomain", ["lxd-domain"]),
      authDomain: cliOption(rawOptions, "authDomain", ["auth-domain"])
    },
    emails: {
      email: cliOption(rawOptions, "email"),
      acmeEmail: cliOption(rawOptions, "acmeEmail", ["acme-email"]),
      zitadelAdminEmail: cliOption(rawOptions, "zitadelAdminEmail", ["zitadel-admin-email"]),
      logtoAdminEmail: cliOption(rawOptions, "logtoAdminEmail", ["logto-admin-email"])
    },
    idp: {
      provider: cliOption(rawOptions, "provider", ["idpProvider", "idp-provider"]),
      adminGroup: cliOption(rawOptions, "adminGroup", ["admin-group"]),
      authDomain: cliOption(rawOptions, "authDomain", ["auth-domain"]),
      oidc: cliOption(rawOptions, "oidc"),
      oidcClient: cliOption(rawOptions, "oidcClient", ["oidc-client"]),
      oidcSecret: secretCliOption(rawOptions, "oidcSecret", "oidcSecretFile", ["oidc-secret"], ["oidc-secret-file"]),
      lxdOidcClient: cliOption(rawOptions, "lxdOidcClient", ["lxd-oidc-client"]),
      lxdOidcSecret: secretCliOption(
        rawOptions,
        "lxdOidcSecret",
        "lxdOidcSecretFile",
        ["lxd-oidc-secret"],
        ["lxd-oidc-secret-file"]
      ),
      oidcGroupsClaim: cliOption(rawOptions, "oidcGroupsClaim", ["oidc-groups-claim"]),
      oidcScopes: cliOption(rawOptions, "oidcScopes", ["oidc-scopes"]),
      lxdOidcGroupsClaim: cliOption(rawOptions, "lxdOidcGroupsClaim", ["lxd-oidc-groups-claim"]),
      lxdOidcScopes: cliOption(rawOptions, "lxdOidcScopes", ["lxd-oidc-scopes"]),
      localIdpOutputsPath: cliOption(rawOptions, "localIdpOutputsPath", ["local-idp-outputs-path"]),
      zitadelAdminEmail: cliOption(rawOptions, "zitadelAdminEmail", ["zitadel-admin-email"]),
      logtoAdminEmail: cliOption(rawOptions, "logtoAdminEmail", ["logto-admin-email"]),
      logtoAdminUsername: cliOption(rawOptions, "logtoAdminUsername", ["logto-admin-username"])
    },
    s3: {
      enable: Boolean(rawOptions.enable),
      disable: Boolean(rawOptions.disable),
      s3Endpoint: cliOption(rawOptions, "s3Endpoint", ["s3-endpoint"]),
      s3Bucket: cliOption(rawOptions, "s3Bucket", ["s3-bucket"]),
      s3Region: cliOption(rawOptions, "s3Region", ["s3-region"]),
      s3Prefix: cliOption(rawOptions, "s3Prefix", ["s3-prefix"]),
      s3AccessKey: cliOption(rawOptions, "s3AccessKey", ["s3-accessKey", "s3-access-key"]),
      s3SecretKey: secretCliOption(
        rawOptions,
        "s3SecretKey",
        "s3SecretKeyFile",
        ["s3-secretKey", "s3-secret-key"],
        ["s3-secretKeyFile", "s3-secret-key-file"]
      )
    },
    syncoid: {
      enable: Boolean(rawOptions.enable),
      disable: Boolean(rawOptions.disable),
      syncoidTarget: cliOption(rawOptions, "syncoidTarget", ["syncoid-target"]),
      syncoidTargetDataset: cliOption(rawOptions, "syncoidTargetDataset", ["syncoid-target-dataset"]),
      syncoidSshKey: cliOption(rawOptions, "syncoidSshKey", ["syncoid-ssh-key"])
    }
  };
}
