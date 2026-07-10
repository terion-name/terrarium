import { describe, expect, test } from "bun:test";
import { idpSyncCmd, resolveLocalIdpSyncProvider, type IdpSyncDependencies } from "../scripts/terrarium-idp-sync";

const CONFIG_PATH = "/tmp/terrarium-config.yaml";

type DispatchResult = {
  loads: Array<{ configPath: string; prefix: string }>;
  zitadelSyncs: string[];
  logtoSyncs: string[];
};

async function dispatchWithConfig(config: Record<string, unknown>): Promise<DispatchResult> {
  const result: DispatchResult = { loads: [], zitadelSyncs: [], logtoSyncs: [] };
  const dependencies: IdpSyncDependencies = {
    loadConfig: (configPath, prefix) => {
      result.loads.push({ configPath, prefix });
      return config;
    },
    syncZitadel: async (configPath) => {
      result.zitadelSyncs.push(configPath);
    },
    syncLogto: async (configPath) => {
      result.logtoSyncs.push(configPath);
    }
  };

  await idpSyncCmd(CONFIG_PATH, dependencies);
  return result;
}

describe("provider-neutral local IDP sync dispatcher", () => {
  test("dispatches local config with no explicit provider to ZITADEL using the supplied config path", async () => {
    const result = await dispatchWithConfig({ terrarium_idp_mode: "local" });

    expect(result.loads).toEqual([{ configPath: CONFIG_PATH, prefix: "terrariumctl idp sync" }]);
    expect(result.zitadelSyncs).toEqual([CONFIG_PATH]);
    expect(result.logtoSyncs).toEqual([]);
  });

  test("dispatches local config with explicit ZITADEL provider to ZITADEL", async () => {
    const result = await dispatchWithConfig({ terrarium_idp_mode: "local", terrarium_idp_provider: "zitadel" });

    expect(result.zitadelSyncs).toEqual([CONFIG_PATH]);
    expect(result.logtoSyncs).toEqual([]);
  });

  test("no-ops for external OIDC config with no explicit provider", async () => {
    const result = await dispatchWithConfig({ terrarium_idp_mode: "oidc" });

    expect(resolveLocalIdpSyncProvider({ terrarium_idp_mode: "oidc" })).toBe("noop");
    expect(result.zitadelSyncs).toEqual([]);
    expect(result.logtoSyncs).toEqual([]);
  });

  test("no-ops for external OIDC config with explicit Logto provider", async () => {
    const result = await dispatchWithConfig({ terrarium_idp_mode: "oidc", terrarium_idp_provider: "logto" });

    expect(resolveLocalIdpSyncProvider({ terrarium_idp_mode: "oidc", terrarium_idp_provider: "logto" })).toBe("noop");
    expect(result.zitadelSyncs).toEqual([]);
    expect(result.logtoSyncs).toEqual([]);
  });

  test("dispatches local config with explicit Logto provider to Logto and does not call ZITADEL", async () => {
    const result = await dispatchWithConfig({ terrarium_idp_mode: "local", terrarium_idp_provider: "logto" });

    expect(resolveLocalIdpSyncProvider({ terrarium_idp_mode: "local", terrarium_idp_provider: "logto" })).toBe("logto");
    expect(result.zitadelSyncs).toEqual([]);
    expect(result.logtoSyncs).toEqual([CONFIG_PATH]);
  });
});
