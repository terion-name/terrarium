import { describe, expect, test } from "bun:test";
import {
  buildCleanupPlan,
  createEmptyResourceManifest,
  recordHetznerServer,
  recordHetznerSshKey,
  recordHetznerVolume,
  recordZitadelFixtureApp,
  recordZitadelFixtureProject,
  recordZitadelFixtureUser,
  removeHetznerServer,
  removeZitadelFixtureApp,
  removeZitadelFixtureProject,
  removeZitadelFixtureUser
} from "./resources";

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

  test("records and removes ZITADEL fixture resources incrementally", () => {
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

    expect(manifest.zitadel.fixtures).toHaveLength(1);
    expect(manifest.zitadel.fixtures[0]).toMatchObject({
      slug: "run-b",
      projectId: "project-1",
      appId: "app-1"
    });
    expect(manifest.zitadel.fixtures[0].users).toHaveLength(1);

    manifest = removeZitadelFixtureUser(manifest, "run-b", "user-1");
    manifest = removeZitadelFixtureApp(manifest, "run-b");
    manifest = removeZitadelFixtureProject(manifest, "run-b");

    expect(manifest.zitadel.fixtures).toEqual([]);
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

    const order = buildCleanupPlan(manifest).map((step) => {
      if (step.provider === "hetzner") {
        return `${step.provider}:${step.resourceType}:${step.resource.id}`;
      }
      if (step.resourceType === "user") {
        return `${step.provider}:${step.resourceType}:${step.resource.userId}`;
      }
      if (step.resourceType === "app") {
        return `${step.provider}:${step.resourceType}:${step.appId}`;
      }
      return `${step.provider}:${step.resourceType}:${step.projectId}`;
    });

    expect(order).toEqual([
      "hetzner:server:3",
      "hetzner:volume:2",
      "hetzner:ssh-key:1",
      "zitadel:user:user-1",
      "zitadel:project:project-1"
    ]);
  });
});
