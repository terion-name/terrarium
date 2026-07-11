import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildCleanupPlan,
  createEmptyResourceManifest,
  loadResourceManifest,
  recordExternalOidcFixtureApp,
  recordHetznerServer,
  recordHetznerSshKey,
  recordHetznerVolume,
  recordZitadelFixtureApp,
  recordZitadelFixtureProject,
  recordZitadelFixtureUser,
  removeHetznerServer,
  removeZitadelFixtureApp,
  removeZitadelFixtureProject,
  removeZitadelFixtureUser,
  type CleanupResourceManifest,
  type CleanupStep
} from "./resources";

function stepKey(step: CleanupStep): string {
  if (step.provider === "hetzner") {
    return `${step.provider}:${step.resourceType}:${step.resource.id}`;
  }
  if (step.resourceType === "user") {
    return `${step.provider}:${step.idpProvider}:${step.resourceType}:${step.resource.userId}`;
  }
  if (step.resourceType === "app") {
    return `${step.provider}:${step.idpProvider}:${step.resourceType}:${step.appId}`;
  }
  if (step.resourceType === "role") {
    return `${step.provider}:${step.idpProvider}:${step.resourceType}:${step.resource.roleId}`;
  }
  if (step.resourceType === "api-resource") {
    return `${step.provider}:${step.idpProvider}:${step.resourceType}:${step.resource.apiResourceId}`;
  }
  if (step.resourceType === "container") {
    return `${step.provider}:${step.idpProvider}:${step.resourceType}:${step.containerId}`;
  }
  return `${step.provider}:${step.idpProvider}:${step.resourceType}:${step.projectId}`;
}

describe("integration cleanup resource manifest", () => {
  test("upserts and removes Hetzner resources by id", () => {
    let manifest = createEmptyResourceManifest("run-a");

    manifest = recordHetznerServer(manifest, { id: 10, name: "old", label: "primary" });
    manifest = recordHetznerServer(manifest, { id: 10, name: "new", label: "primary", ipv4: "192.0.2.10" });
    manifest = recordHetznerVolume(manifest, { id: 20, name: "volume", label: "primary", serverId: 10 });
    manifest = recordHetznerSshKey(manifest, { id: 30, name: "key" });

    expect(manifest.hetzner.servers).toHaveLength(1);
    expect(manifest.hetzner.servers[0]).toMatchObject({ id: 10, name: "new", ipv4: "192.0.2.10" });
    expect(manifest.hetzner.volumes[0]).toMatchObject({ id: 20, serverId: 10 });
    expect(manifest.hetzner.sshKeys[0]).toMatchObject({ id: 30, name: "key" });

    manifest = removeHetznerServer(manifest, 10);

    expect(manifest.hetzner.servers).toEqual([]);
    expect(manifest.hetzner.volumes).toHaveLength(1);
  });

  test("records and removes ZITADEL fixture resources through external OIDC records", () => {
    let manifest = createEmptyResourceManifest("run-b");

    manifest = recordZitadelFixtureProject(manifest, {
      slug: "run-b",
      projectId: "project-1",
      projectName: "terrarium-run-b",
      adminGroup: "terrarium-admins",
      routeGroups: ["agents", "admins"]
    });
    manifest = recordZitadelFixtureApp(manifest, {
      slug: "run-b",
      projectId: "project-1",
      appId: "app-1",
      appName: "terrarium-run-b-external"
    });
    manifest = recordZitadelFixtureUser(manifest, {
      slug: "run-b",
      kind: "adminUser",
      userId: "user-1",
      email: "admin@example.test",
      roles: ["terrarium-admins"]
    });

    expect(manifest.zitadel.fixtures).toEqual([]);
    expect(manifest.externalOidc.fixtures).toHaveLength(1);
    expect(manifest.externalOidc.fixtures[0]).toMatchObject({
      idpProvider: "zitadel",
      slug: "run-b",
      projectId: "project-1",
      applications: [{ appId: "app-1" }]
    });
    expect(manifest.externalOidc.fixtures[0].users).toHaveLength(1);

    manifest = removeZitadelFixtureUser(manifest, "run-b", "user-1");
    manifest = removeZitadelFixtureApp(manifest, "run-b", "app-1");
    manifest = removeZitadelFixtureProject(manifest, "run-b");

    expect(manifest.externalOidc.fixtures).toEqual([]);
    expect(manifest.zitadel.fixtures).toEqual([]);
  });

  test("does not record secret-like external OIDC application fields", () => {
    const manifest = recordExternalOidcFixtureApp(createEmptyResourceManifest("run-secret"), {
      idpProvider: "logto",
      slug: "run-secret",
      appId: "app-public",
      appName: "public app",
      clientId: "client-public",
      clientSecret: "do-not-record",
      generatedEnv: "TERRARIUM_SECRET=do-not-record"
    } as Parameters<typeof recordExternalOidcFixtureApp>[1] & { clientSecret: string; generatedEnv: string });

    const serialized = JSON.stringify(manifest.externalOidc);
    expect(serialized).toContain("client-public");
    expect(serialized).not.toContain("clientSecret");
    expect(serialized).not.toContain("generatedEnv");
    expect(serialized).not.toContain("do-not-record");
  });

  test("builds order-aware cleanup steps", () => {
    let manifest = createEmptyResourceManifest("run-c");
    manifest = recordHetznerSshKey(manifest, { id: 1, name: "key" });
    manifest = recordHetznerVolume(manifest, { id: 2, name: "volume", label: "primary", serverId: 3 });
    manifest = recordHetznerServer(manifest, { id: 3, name: "server", label: "primary" });
    manifest = recordZitadelFixtureProject(manifest, {
      slug: "run-c",
      projectId: "project-1",
      projectName: "terrarium-run-c",
      adminGroup: "terrarium-admins",
      routeGroups: []
    });
    manifest = recordZitadelFixtureApp(manifest, {
      slug: "run-c",
      projectId: "project-1",
      appId: "app-1",
      appName: "terrarium-run-c-external"
    });
    manifest = recordZitadelFixtureUser(manifest, {
      slug: "run-c",
      kind: "routeUser",
      userId: "user-1",
      email: "agent@example.test",
      roles: ["agents"]
    });

    expect(buildCleanupPlan(manifest).map(stepKey)).toEqual([
      "hetzner:server:3",
      "hetzner:volume:2",
      "hetzner:ssh-key:1",
      "external-oidc:zitadel:user:user-1",
      "external-oidc:zitadel:project:project-1"
    ]);
  });

  test("clears project-scoped ZITADEL resources after project deletion", () => {
    let manifest = createEmptyResourceManifest("run-zitadel-cascade");
    manifest = recordZitadelFixtureProject(manifest, {
      slug: "run-zitadel-cascade",
      projectId: "project-1",
      projectName: "terrarium-run-zitadel-cascade",
      adminGroup: "terrarium-admins",
      routeGroups: ["agents"]
    });
    manifest = recordZitadelFixtureApp(manifest, {
      slug: "run-zitadel-cascade",
      projectId: "project-1",
      appId: "app-1",
      appName: "terrarium-run-zitadel-cascade-external"
    });

    manifest = removeZitadelFixtureProject(manifest, "run-zitadel-cascade");

    expect(manifest.externalOidc.fixtures).toEqual([]);
    expect(buildCleanupPlan(manifest)).toEqual([]);
  });

  test("loads and plans legacy ZITADEL manifests without external OIDC records", () => {
    const directory = mkdtempSync(join(tmpdir(), "terrarium-resources-"));
    const path = join(directory, "resources.json");
    try {
      writeFileSync(
        path,
        `${JSON.stringify(
          {
            version: 1,
            slug: "legacy-run",
            updatedAt: "2026-01-01T00:00:00.000Z",
            hetzner: {},
            zitadel: {
              fixtures: [
                {
                  slug: "legacy-run",
                  projectId: "legacy-project",
                  projectName: "legacy project",
                  appId: "legacy-app",
                  appName: "legacy app",
                  routeGroups: undefined,
                  users: [
                    {
                      kind: "adminUser",
                      userId: "legacy-user",
                      email: "legacy@example.test",
                      roles: ["admins"],
                      createdAt: "2026-01-01T00:00:00.000Z"
                    }
                  ],
                  createdAt: "2026-01-01T00:00:00.000Z"
                }
              ]
            }
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      let manifest = loadResourceManifest(path, "legacy-run");

      expect(manifest.externalOidc.fixtures).toEqual([]);
      expect(manifest.zitadel.fixtures[0].routeGroups).toEqual([]);
      expect(buildCleanupPlan(manifest).map(stepKey)).toEqual([
        "external-oidc:zitadel:user:legacy-user",
        "external-oidc:zitadel:project:legacy-project"
      ]);

      manifest = removeZitadelFixtureUser(manifest, "legacy-run", "legacy-user");
      manifest = removeZitadelFixtureApp(manifest, "legacy-run", "legacy-app");
      manifest = removeZitadelFixtureProject(manifest, "legacy-run");
      manifest = removeZitadelFixtureProject(manifest, "legacy-run");

      expect(manifest.zitadel.fixtures).toEqual([]);
      expect(buildCleanupPlan(manifest)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("orders neutral external OIDC resources by cleanup phase", () => {
    const manifest: CleanupResourceManifest = {
      ...createEmptyResourceManifest("neutral-run"),
      externalOidc: {
        fixtures: [
          {
            idpProvider: "zitadel",
            slug: "neutral-zitadel",
            projectId: "project-zitadel",
            projectName: "zitadel project",
            routeGroups: [],
            users: [],
            applications: [],
            roles: [],
            apiResources: [],
            createdAt: "2026-01-01T00:00:00.000Z"
          },
          {
            idpProvider: "logto",
            slug: "neutral-logto",
            containerId: "container-logto",
            containerName: "logto container",
            routeGroups: ["agents"],
            users: [
              {
                kind: "adminUser",
                userId: "user-1",
                email: "user-1@example.test",
                roles: [],
                createdAt: "2026-01-01T00:00:00.000Z"
              },
              {
                kind: "routeUser",
                userId: "user-2",
                email: "user-2@example.test",
                roles: ["agents"],
                createdAt: "2026-01-01T00:00:01.000Z"
              }
            ],
            applications: [
              { appId: "app-1", appName: "app one", createdAt: "2026-01-01T00:00:02.000Z" },
              { appId: "app-2", appName: "app two", createdAt: "2026-01-01T00:00:03.000Z" }
            ],
            roles: [{ roleId: "role-1", roleName: "role one", createdAt: "2026-01-01T00:00:04.000Z" }],
            apiResources: [
              { apiResourceId: "api-1", apiResourceName: "api one", createdAt: "2026-01-01T00:00:05.000Z" }
            ],
            createdAt: "2026-01-01T00:00:00.000Z"
          }
        ]
      }
    };

    expect(buildCleanupPlan(manifest).map(stepKey)).toEqual([
      "external-oidc:logto:user:user-2",
      "external-oidc:logto:user:user-1",
      "external-oidc:logto:app:app-2",
      "external-oidc:logto:app:app-1",
      "external-oidc:logto:role:role-1",
      "external-oidc:logto:api-resource:api-1",
      "external-oidc:logto:container:container-logto",
      "external-oidc:zitadel:project:project-zitadel"
    ]);
  });
});
