export type PublicIdpProvider = "zitadel" | "logto";
export type EffectiveIdpProvider = PublicIdpProvider | "generic";

export const GENERIC_IDP_DEFAULT_GROUPS_CLAIM = "groups";
export const GENERIC_IDP_DEFAULT_SCOPES = "openid profile email";
export const ZITADEL_IDP_DEFAULT_GROUPS_CLAIM = GENERIC_IDP_DEFAULT_GROUPS_CLAIM;
export const ZITADEL_IDP_DEFAULT_SCOPES = GENERIC_IDP_DEFAULT_SCOPES;
export const LOGTO_IDP_DEFAULT_GROUPS_CLAIM = "roles";
export const LOGTO_IDP_DEFAULT_SCOPES = "openid profile email roles";
export const DEFAULT_LOCAL_IDP_OUTPUTS_PATH = "/etc/terrarium/zitadel-apps.json";
export const PUBLIC_IDP_PROVIDERS = ["zitadel", "logto"] as const satisfies readonly PublicIdpProvider[];

export type IdpProviderConfig = Record<string, unknown>;

type ProviderDefaults = {
  groupsClaim: string;
  scopes: string;
};

function nonEmptyConfigValue(config: IdpProviderConfig, key: string): string {
  const value = config[key];
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

export function normalizePublicIdpProvider(provider: string): PublicIdpProvider | "" {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "zitadel" || normalized === "logto") {
    return normalized;
  }
  return "";
}

export function validatePublicIdpProvider(provider: string): PublicIdpProvider {
  const normalized = normalizePublicIdpProvider(provider);
  if (!normalized) {
    throw new Error(`invalid IDP provider ${JSON.stringify(provider)}; expected one of: ${PUBLIC_IDP_PROVIDERS.join(", ")}`);
  }
  return normalized;
}

export function resolveEffectiveIdpProvider(mode: string, explicitProvider = ""): EffectiveIdpProvider {
  const provider = explicitProvider.trim();
  if (provider) {
    return validatePublicIdpProvider(provider);
  }
  return mode.trim().toLowerCase() === "local" ? "zitadel" : "generic";
}

export function defaultIdpProviderValues(provider: EffectiveIdpProvider): ProviderDefaults {
  if (provider === "logto") {
    return { groupsClaim: LOGTO_IDP_DEFAULT_GROUPS_CLAIM, scopes: LOGTO_IDP_DEFAULT_SCOPES };
  }
  return { groupsClaim: GENERIC_IDP_DEFAULT_GROUPS_CLAIM, scopes: GENERIC_IDP_DEFAULT_SCOPES };
}

export function resolveOidcGroupsClaim(config: IdpProviderConfig, provider: EffectiveIdpProvider): string {
  return nonEmptyConfigValue(config, "terrarium_oidc_groups_claim") || defaultIdpProviderValues(provider).groupsClaim;
}

export function resolveOidcScopes(config: IdpProviderConfig, provider: EffectiveIdpProvider): string {
  return nonEmptyConfigValue(config, "terrarium_oidc_scopes") || defaultIdpProviderValues(provider).scopes;
}

export function resolveLxdOidcGroupsClaim(config: IdpProviderConfig, provider: EffectiveIdpProvider): string {
  return nonEmptyConfigValue(config, "terrarium_lxd_oidc_groups_claim") || defaultIdpProviderValues(provider).groupsClaim;
}

export function resolveLxdOidcScopes(config: IdpProviderConfig, provider: EffectiveIdpProvider): string {
  return nonEmptyConfigValue(config, "terrarium_lxd_oidc_scopes") || defaultIdpProviderValues(provider).scopes;
}

export function resolveLocalIdpOutputsPath(config: IdpProviderConfig): string {
  return (
    nonEmptyConfigValue(config, "terrarium_local_idp_outputs_path") ||
    nonEmptyConfigValue(config, "terrarium_zitadel_outputs_path") ||
    DEFAULT_LOCAL_IDP_OUTPUTS_PATH
  );
}
