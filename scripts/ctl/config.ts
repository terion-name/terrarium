import { input } from "@inquirer/prompts";
import { stringify } from "yaml";
import { normalizeOidcIssuer, validateEmail } from "../terrarium-install";
import {
  cliOption,
  CONFIG_PATH,
  defaultServiceDomain,
  loadMutableConfig,
  localIdpEnabled,
  MutableConfig,
  setConfigValue,
  success
} from "./context";
import { configBoolean, configString, normalizeS3Endpoint } from "../lib/common";
import { writeFileSync } from "node:fs";
import { verifyOidcConfig, verifyS3Config } from "./verify";

/** Callback bundle used after any persisted config change that affects the running host. */
export type ReconcileActions = {
  reconfigure: () => Promise<void>;
  syncProxy: () => Promise<void>;
  syncIdp: () => Promise<void>;
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
};

/** Reusable option bag for `set idp`. */
export type SetIdpOptions = {
  mode: string;
  adminGroup?: string;
  authDomain?: string;
  oidc?: string;
  oidcClient?: string;
  oidcSecret?: string;
  zitadelAdminEmail?: string;
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
};

/** Reusable option bag for `set syncoid`. */
export type SetSyncoidOptions = {
  enable?: boolean;
  disable?: boolean;
  syncoidTarget?: string;
  syncoidTargetDataset?: string;
  syncoidSshKey?: string;
};

/**
 * Writes a config document and converges the live host to match it.
 *
 * Every `set ...` command should go through this helper so the persisted config
 * and the actual host state never drift for long.
 */
async function persistAndReconcile(config: MutableConfig, summary: string, actions: ReconcileActions): Promise<void> {
  writeFileSync(CONFIG_PATH, stringify(config), "utf8");
  await actions.reconfigure();
  await actions.syncProxy();
  if (localIdpEnabled(config)) {
    await actions.syncIdp();
  }
  console.log(success(summary));
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
    setConfigValue(config, "terrarium_auth_domain", authDomain);
    setConfigValue(config, "terrarium_oidc_issuer", normalizeOidcIssuer(`https://${authDomain}/`, "--oidc"));
  }

  if (!localIdpEnabled(config)) {
    await verifyOidcConfig({
      issuer: configString(config, "terrarium_oidc_issuer"),
      clientId: configString(config, "terrarium_oidc_client_id"),
      clientSecret: configString(config, "terrarium_oidc_client_secret"),
      manageDomain: configString(config, "terrarium_manage_domain"),
      lxdDomain: configString(config, "terrarium_lxd_domain")
    });
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
  if (!options.email && !options.acmeEmail && !options.zitadelAdminEmail) {
    throw new Error("set emails requires at least one of --email, --acme-email, or --zitadel-admin-email");
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

  await persistAndReconcile(config, "Updated email settings", actions);
}

/** Switches between self-hosted ZITADEL and external OIDC management auth modes. */
export async function setIdpCmd(options: SetIdpOptions, actions: ReconcileActions): Promise<void> {
  const config = loadMutableConfig();
  const publicIp = configString(config, "terrarium_public_ip");
  const rootDomain = configString(config, "terrarium_root_domain");
  const nextMode = options.mode.trim().toLowerCase();
  if (!["local", "oidc"].includes(nextMode)) {
    throw new Error("set idp requires mode 'local' or 'oidc'");
  }

  setConfigValue(config, "terrarium_idp_mode", nextMode);
  if (nextMode === "local") {
    const nextAdminGroup = options.adminGroup || configString(config, "terrarium_admin_group") || "terrarium-admins";
    const authDomain = options.authDomain || configString(config, "terrarium_auth_domain") || defaultServiceDomain(rootDomain, publicIp, "auth");
    setConfigValue(config, "terrarium_admin_group", nextAdminGroup);
    setConfigValue(config, "terrarium_auth_domain", authDomain);
    setConfigValue(config, "terrarium_oidc_issuer", normalizeOidcIssuer(`https://${authDomain}/`, "--oidc"));
    setConfigValue(config, "terrarium_oidc_client_id", "");
    setConfigValue(config, "terrarium_oidc_client_secret", "");
    const currentAdmin = options.zitadelAdminEmail || configString(config, "terrarium_zitadel_admin_email") || configString(config, "terrarium_email");
    setConfigValue(config, "terrarium_zitadel_admin_email", validateEmail(currentAdmin, "--zitadel-admin-email"));
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
    setConfigValue(config, "terrarium_auth_domain", "");
    setConfigValue(config, "terrarium_admin_group", nextAdminGroup);
    setConfigValue(config, "terrarium_oidc_issuer", normalizeOidcIssuer(issuer, "--oidc"));
    setConfigValue(config, "terrarium_oidc_client_id", clientId);
    setConfigValue(config, "terrarium_oidc_client_secret", clientSecret);
    await verifyOidcConfig({
      issuer: configString(config, "terrarium_oidc_issuer"),
      clientId: configString(config, "terrarium_oidc_client_id"),
      clientSecret: configString(config, "terrarium_oidc_client_secret"),
      manageDomain: configString(config, "terrarium_manage_domain"),
      lxdDomain: configString(config, "terrarium_lxd_domain")
    });
  }

  await persistAndReconcile(config, nextMode === "local" ? "Switched IDP mode to local" : "Switched IDP mode to oidc", actions);
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
      manageDomain: cliOption(rawOptions, "manageDomain"),
      proxyDomain: cliOption(rawOptions, "proxyDomain"),
      lxdDomain: cliOption(rawOptions, "lxdDomain"),
      authDomain: cliOption(rawOptions, "authDomain")
    },
    emails: {
      email: cliOption(rawOptions, "email"),
      acmeEmail: cliOption(rawOptions, "acmeEmail"),
      zitadelAdminEmail: cliOption(rawOptions, "zitadelAdminEmail")
    },
    idp: {
      adminGroup: cliOption(rawOptions, "adminGroup"),
      authDomain: cliOption(rawOptions, "authDomain"),
      oidc: cliOption(rawOptions, "oidc"),
      oidcClient: cliOption(rawOptions, "oidcClient"),
      oidcSecret: cliOption(rawOptions, "oidcSecret"),
      zitadelAdminEmail: cliOption(rawOptions, "zitadelAdminEmail")
    },
    s3: {
      enable: Boolean(rawOptions.enable),
      disable: Boolean(rawOptions.disable),
      s3Endpoint: cliOption(rawOptions, "s3Endpoint", ["s3-endpoint"]),
      s3Bucket: cliOption(rawOptions, "s3Bucket", ["s3-bucket"]),
      s3Region: cliOption(rawOptions, "s3Region", ["s3-region"]),
      s3Prefix: cliOption(rawOptions, "s3Prefix", ["s3-prefix"]),
      s3AccessKey: cliOption(rawOptions, "s3AccessKey", ["s3-accessKey", "s3-access-key"]),
      s3SecretKey: cliOption(rawOptions, "s3SecretKey", ["s3-secretKey", "s3-secret-key"])
    },
    syncoid: {
      enable: Boolean(rawOptions.enable),
      disable: Boolean(rawOptions.disable),
      syncoidTarget: cliOption(rawOptions, "syncoidTarget"),
      syncoidTargetDataset: cliOption(rawOptions, "syncoidTargetDataset"),
      syncoidSshKey: cliOption(rawOptions, "syncoidSshKey")
    }
  };
}
