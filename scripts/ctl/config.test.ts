import { describe, expect, test } from "bun:test";
import { applySetIdpConfig, runReconcileActions, type ReconcileActions } from "./config";

function recordActions(calls: string[], outputs: string[] = [""]): ReconcileActions {
  return {
    reconfigure: async () => {
      calls.push("reconfigure");
    },
    syncIdp: async () => {
      calls.push("syncIdp");
    },
    syncProxy: async () => {
      calls.push("syncProxy");
    },
    readLocalIdpOutputs: async () => {
      return outputs.shift() ?? outputs.at(-1) ?? "";
    }
  };
}

describe("terrariumctl config reconciliation", () => {
  test("syncs local IDP outputs before proxy config convergence finishes", async () => {
    const calls: string[] = [];

    await runReconcileActions({ terrarium_idp_mode: "local" }, recordActions(calls, ["same", "same"]));

    expect(calls).toEqual(["reconfigure", "syncIdp", "syncProxy"]);
  });

  test("reruns Ansible when local IDP sync changes oauth client outputs", async () => {
    const calls: string[] = [];

    await runReconcileActions({ terrarium_idp_mode: "local" }, recordActions(calls, ["old-client", "new-client", "new-client", "new-client"]));

    expect(calls).toEqual(["reconfigure", "syncIdp", "reconfigure", "syncIdp", "syncProxy"]);
  });

  test("keeps rerunning Ansible until final local IDP outputs are consumed", async () => {
    const calls: string[] = [];

    await runReconcileActions(
      { terrarium_idp_mode: "local" },
      recordActions(calls, ["old-client", "mid-client", "mid-client", "new-client", "new-client", "new-client"])
    );

    expect(calls).toEqual(["reconfigure", "syncIdp", "reconfigure", "syncIdp", "reconfigure", "syncIdp", "syncProxy"]);
  });

  test("fails instead of continuing when local IDP outputs never stabilize", async () => {
    const calls: string[] = [];

    await expect(
      runReconcileActions(
        { terrarium_idp_mode: "local" },
        recordActions(calls, ["client-1", "client-2", "client-2", "client-3", "client-3", "client-4", "client-4", "client-5"])
      )
    ).rejects.toThrow("local IDP outputs kept changing");

    expect(calls).toEqual(["reconfigure", "syncIdp", "reconfigure", "syncIdp", "reconfigure", "syncIdp", "reconfigure", "syncIdp", "reconfigure"]);
  });

  test("skips IDP sync for external OIDC mode", async () => {
    const calls: string[] = [];

    await runReconcileActions({ terrarium_idp_mode: "oidc" }, recordActions(calls));

    expect(calls).toEqual(["reconfigure", "syncProxy"]);
  });

  test("preserves the local auth domain when switching to external OIDC", () => {
    const config: Record<string, unknown> = {
      terrarium_public_ip: "203.0.113.10",
      terrarium_root_domain: "example.test",
      terrarium_manage_domain: "primary-manage.example.test",
      terrarium_lxd_domain: "primary-lxd.example.test",
      terrarium_auth_domain: "primary-auth.example.test",
      terrarium_admin_group: "terrarium-admins"
    };

    const plan = applySetIdpConfig(config, {
      mode: "oidc",
      oidc: "https://issuer.example.test/",
      oidcClient: "client-1",
      oidcSecret: "secret-1"
    });

    expect(config.terrarium_auth_domain).toBe("primary-auth.example.test");
    expect(config.terrarium_oidc_issuer).toBe("https://issuer.example.test");
    expect(plan.verifyOidc).toEqual({
      issuer: "https://issuer.example.test",
      clientId: "client-1",
      clientSecret: "secret-1",
      manageDomain: "primary-manage.example.test",
      lxdDomain: "primary-lxd.example.test"
    });
  });

  test("reuses the preserved local auth domain when switching back to local IDP", () => {
    const config: Record<string, unknown> = {
      terrarium_public_ip: "203.0.113.10",
      terrarium_root_domain: "example.test",
      terrarium_email: "admin@example.test",
      terrarium_manage_domain: "primary-manage.example.test",
      terrarium_lxd_domain: "primary-lxd.example.test",
      terrarium_auth_domain: "primary-auth.example.test",
      terrarium_admin_group: "terrarium-admins",
      terrarium_oidc_issuer: "https://issuer.example.test/",
      terrarium_oidc_client_id: "client-1",
      terrarium_oidc_client_secret: "secret-1"
    };

    const plan = applySetIdpConfig(config, { mode: "local" });

    expect(plan.verifyOidc).toBeUndefined();
    expect(config.terrarium_auth_domain).toBe("primary-auth.example.test");
    expect(config.terrarium_oidc_issuer).toBe("https://primary-auth.example.test");
    expect(config.terrarium_oidc_client_id).toBe("");
    expect(config.terrarium_oidc_client_secret).toBe("");
  });
});
