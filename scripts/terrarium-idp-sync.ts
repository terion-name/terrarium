import { configString, loadConfig } from "./lib/common";
import { resolveEffectiveIdpProvider, type EffectiveIdpProvider } from "./lib/idp-provider";
import { idpSyncCmd as logtoIdpSyncCmd } from "./terrarium-logto-sync";
import { idpSyncCmd as zitadelIdpSyncCmd } from "./terrarium-zitadel-sync";

const PREFIX = "terrariumctl idp sync";
const DEFAULT_CONFIG_PATH = process.env.TERRARIUM_CONFIG_PATH ?? "/etc/terrarium/config.yaml";

export type IdpSyncDependencies = {
  loadConfig: (configPath: string, prefix: string) => Record<string, unknown>;
  syncZitadel: (configPath: string) => Promise<void>;
  syncLogto: (configPath: string) => Promise<void> | void;
};

type LocalIdpSyncProvider = "zitadel" | "logto";

const defaultDependencies: IdpSyncDependencies = {
  loadConfig,
  syncZitadel: zitadelIdpSyncCmd,
  syncLogto: logtoIdpSyncCmd
};

function assertLocalIdpSyncProvider(provider: EffectiveIdpProvider): LocalIdpSyncProvider {
  if (provider === "zitadel" || provider === "logto") {
    return provider;
  }
  throw new Error(`unsupported local IDP sync provider: ${provider}`);
}

export function resolveLocalIdpSyncProvider(config: Record<string, unknown>): LocalIdpSyncProvider | "noop" {
  const mode = configString(config, "terrarium_idp_mode").toLowerCase();
  if (mode !== "local") {
    return "noop";
  }

  return assertLocalIdpSyncProvider(resolveEffectiveIdpProvider(mode, configString(config, "terrarium_idp_provider")));
}

export async function idpSyncCmd(configPath = DEFAULT_CONFIG_PATH, dependencies: IdpSyncDependencies = defaultDependencies): Promise<void> {
  const config = dependencies.loadConfig(configPath, PREFIX);
  const provider = resolveLocalIdpSyncProvider(config);

  if (provider === "noop") {
    return;
  }
  if (provider === "zitadel") {
    await dependencies.syncZitadel(configPath);
    return;
  }
  if (provider === "logto") {
    await dependencies.syncLogto(configPath);
    return;
  }

  const unsupportedProvider: never = provider;
  throw new Error(`unsupported local IDP sync provider: ${unsupportedProvider}`);
}
