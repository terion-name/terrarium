import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type HetznerSshKeyResource = {
  id: number;
  name: string;
  createdAt: string;
};

export type HetznerServerResource = {
  id: number;
  name: string;
  label: string;
  ipv4?: string;
  createdAt: string;
};

export type HetznerVolumeResource = {
  id: number;
  name: string;
  label: string;
  serverId?: number;
  linuxDevice?: string;
  createdAt: string;
};

export type ZitadelFixtureUserKind = "adminUser" | "routeUser" | "deniedUser";

export type ZitadelFixtureUserResource = {
  kind: ZitadelFixtureUserKind;
  userId: string;
  email: string;
  roles: string[];
  createdAt: string;
};

export type ZitadelFixtureResource = {
  slug: string;
  projectId?: string;
  projectName?: string;
  appId?: string;
  appName?: string;
  adminGroup?: string;
  routeGroups: string[];
  users: ZitadelFixtureUserResource[];
  createdAt: string;
};

export type CleanupResourceManifest = {
  version: 1;
  slug: string;
  updatedAt: string;
  hetzner: {
    sshKeys: HetznerSshKeyResource[];
    servers: HetznerServerResource[];
    volumes: HetznerVolumeResource[];
  };
  zitadel: {
    fixtures: ZitadelFixtureResource[];
  };
};

export type CleanupStep =
  | { provider: "hetzner"; resourceType: "server"; resource: HetznerServerResource }
  | { provider: "hetzner"; resourceType: "volume"; resource: HetznerVolumeResource }
  | { provider: "hetzner"; resourceType: "ssh-key"; resource: HetznerSshKeyResource }
  | { provider: "zitadel"; resourceType: "user"; fixtureSlug: string; resource: ZitadelFixtureUserResource }
  | { provider: "zitadel"; resourceType: "app"; fixtureSlug: string; projectId: string; appId: string; appName?: string }
  | { provider: "zitadel"; resourceType: "project"; fixtureSlug: string; projectId: string; projectName?: string };

type Timestamped<T> = Omit<T, "createdAt"> & { createdAt?: string };

function timestamp(): string {
  return new Date().toISOString();
}

export function createEmptyResourceManifest(slug: string): CleanupResourceManifest {
  const now = timestamp();
  return {
    version: 1,
    slug,
    updatedAt: now,
    hetzner: {
      sshKeys: [],
      servers: [],
      volumes: []
    },
    zitadel: {
      fixtures: []
    }
  };
}

export function loadResourceManifest(path: string, slug: string): CleanupResourceManifest {
  if (!existsSync(path)) {
    return createEmptyResourceManifest(slug);
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as CleanupResourceManifest;
  if (parsed.version !== 1) {
    throw new Error(`unsupported cleanup resource manifest version in ${path}`);
  }

  return {
    ...createEmptyResourceManifest(slug),
    ...parsed,
    hetzner: {
      sshKeys: parsed.hetzner?.sshKeys ?? [],
      servers: parsed.hetzner?.servers ?? [],
      volumes: parsed.hetzner?.volumes ?? []
    },
    zitadel: {
      fixtures: (parsed.zitadel?.fixtures ?? []).map((fixture) => ({
        ...fixture,
        routeGroups: fixture.routeGroups ?? [],
        users: fixture.users ?? []
      }))
    }
  };
}

export function saveResourceManifest(path: string, manifest: CleanupResourceManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = { ...manifest, updatedAt: timestamp() };
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, path);
}

function upsertById<T extends { id: number }>(items: T[], resource: T): T[] {
  const withoutExisting = items.filter((item) => item.id !== resource.id);
  return [...withoutExisting, resource];
}

function upsertUser(users: ZitadelFixtureUserResource[], resource: ZitadelFixtureUserResource): ZitadelFixtureUserResource[] {
  const withoutExisting = users.filter((user) => user.userId !== resource.userId);
  return [...withoutExisting, resource];
}

function resourceTimestamp(existing?: { createdAt: string }, createdAt?: string): string {
  return createdAt ?? existing?.createdAt ?? timestamp();
}

export function recordHetznerSshKey(
  manifest: CleanupResourceManifest,
  resource: Timestamped<HetznerSshKeyResource>
): CleanupResourceManifest {
  const existing = manifest.hetzner.sshKeys.find((item) => item.id === resource.id);
  return {
    ...manifest,
    hetzner: {
      ...manifest.hetzner,
      sshKeys: upsertById(manifest.hetzner.sshKeys, {
        ...resource,
        createdAt: resourceTimestamp(existing, resource.createdAt)
      })
    }
  };
}

export function removeHetznerSshKey(manifest: CleanupResourceManifest, id: number): CleanupResourceManifest {
  return {
    ...manifest,
    hetzner: {
      ...manifest.hetzner,
      sshKeys: manifest.hetzner.sshKeys.filter((resource) => resource.id !== id)
    }
  };
}

export function recordHetznerServer(
  manifest: CleanupResourceManifest,
  resource: Timestamped<HetznerServerResource>
): CleanupResourceManifest {
  const existing = manifest.hetzner.servers.find((item) => item.id === resource.id);
  return {
    ...manifest,
    hetzner: {
      ...manifest.hetzner,
      servers: upsertById(manifest.hetzner.servers, {
        ...resource,
        createdAt: resourceTimestamp(existing, resource.createdAt)
      })
    }
  };
}

export function removeHetznerServer(manifest: CleanupResourceManifest, id: number): CleanupResourceManifest {
  return {
    ...manifest,
    hetzner: {
      ...manifest.hetzner,
      servers: manifest.hetzner.servers.filter((resource) => resource.id !== id)
    }
  };
}

export function recordHetznerVolume(
  manifest: CleanupResourceManifest,
  resource: Timestamped<HetznerVolumeResource>
): CleanupResourceManifest {
  const existing = manifest.hetzner.volumes.find((item) => item.id === resource.id);
  return {
    ...manifest,
    hetzner: {
      ...manifest.hetzner,
      volumes: upsertById(manifest.hetzner.volumes, {
        ...resource,
        createdAt: resourceTimestamp(existing, resource.createdAt)
      })
    }
  };
}

export function removeHetznerVolume(manifest: CleanupResourceManifest, id: number): CleanupResourceManifest {
  return {
    ...manifest,
    hetzner: {
      ...manifest.hetzner,
      volumes: manifest.hetzner.volumes.filter((resource) => resource.id !== id)
    }
  };
}

function upsertFixture(manifest: CleanupResourceManifest, fixture: ZitadelFixtureResource): CleanupResourceManifest {
  const withoutExisting = manifest.zitadel.fixtures.filter((item) => item.slug !== fixture.slug);
  return {
    ...manifest,
    zitadel: {
      fixtures: [...withoutExisting, fixture]
    }
  };
}

function fixtureFor(
  manifest: CleanupResourceManifest,
  slug: string,
  seed?: Partial<ZitadelFixtureResource>
): ZitadelFixtureResource {
  const existing = manifest.zitadel.fixtures.find((fixture) => fixture.slug === slug);
  return {
    slug,
    createdAt: timestamp(),
    ...existing,
    ...seed,
    routeGroups: seed?.routeGroups ?? existing?.routeGroups ?? [],
    users: existing?.users ?? []
  };
}

export function recordZitadelFixtureProject(
  manifest: CleanupResourceManifest,
  resource: {
    slug: string;
    projectId: string;
    projectName: string;
    adminGroup: string;
    routeGroups: string[];
  }
): CleanupResourceManifest {
  const fixture = fixtureFor(manifest, resource.slug, {
    projectId: resource.projectId,
    projectName: resource.projectName,
    adminGroup: resource.adminGroup,
    routeGroups: resource.routeGroups
  });
  return upsertFixture(manifest, fixture);
}

export function recordZitadelFixtureApp(
  manifest: CleanupResourceManifest,
  resource: {
    slug: string;
    projectId: string;
    appId: string;
    appName: string;
  }
): CleanupResourceManifest {
  const fixture = fixtureFor(manifest, resource.slug, {
    projectId: resource.projectId,
    appId: resource.appId,
    appName: resource.appName
  });
  return upsertFixture(manifest, fixture);
}

export function removeZitadelFixtureApp(manifest: CleanupResourceManifest, slug: string): CleanupResourceManifest {
  const existing = manifest.zitadel.fixtures.find((fixture) => fixture.slug === slug);
  if (!existing) {
    return manifest;
  }
  const { appId: _appId, appName: _appName, ...fixture } = existing;
  return upsertFixture(manifest, fixture);
}

export function recordZitadelFixtureUser(
  manifest: CleanupResourceManifest,
  resource: {
    slug: string;
    kind: ZitadelFixtureUserKind;
    userId: string;
    email: string;
    roles: string[];
    createdAt?: string;
  }
): CleanupResourceManifest {
  const fixture = fixtureFor(manifest, resource.slug);
  return upsertFixture(manifest, {
    ...fixture,
    users: upsertUser(fixture.users, {
      kind: resource.kind,
      userId: resource.userId,
      email: resource.email,
      roles: resource.roles,
      createdAt: resourceTimestamp(fixture.users.find((user) => user.userId === resource.userId), resource.createdAt)
    })
  });
}

export function removeZitadelFixtureUser(
  manifest: CleanupResourceManifest,
  slug: string,
  userId: string
): CleanupResourceManifest {
  const existing = manifest.zitadel.fixtures.find((fixture) => fixture.slug === slug);
  if (!existing) {
    return manifest;
  }
  return upsertFixture(manifest, {
    ...existing,
    users: existing.users.filter((user) => user.userId !== userId)
  });
}

export function removeZitadelFixtureProject(manifest: CleanupResourceManifest, slug: string): CleanupResourceManifest {
  const existing = manifest.zitadel.fixtures.find((fixture) => fixture.slug === slug);
  if (!existing) {
    return manifest;
  }
  if (existing.users.length > 0) {
    const {
      appId: _appId,
      appName: _appName,
      projectId: _projectId,
      projectName: _projectName,
      ...fixture
    } = existing;
    return upsertFixture(manifest, fixture);
  }
  return {
    ...manifest,
    zitadel: {
      fixtures: manifest.zitadel.fixtures.filter((fixture) => fixture.slug !== slug)
    }
  };
}

export function buildCleanupPlan(manifest: CleanupResourceManifest): CleanupStep[] {
  const steps: CleanupStep[] = [];
  for (const resource of [...manifest.hetzner.servers].reverse()) {
    steps.push({ provider: "hetzner", resourceType: "server", resource });
  }
  for (const resource of [...manifest.hetzner.volumes].reverse()) {
    steps.push({ provider: "hetzner", resourceType: "volume", resource });
  }
  for (const resource of [...manifest.hetzner.sshKeys].reverse()) {
    steps.push({ provider: "hetzner", resourceType: "ssh-key", resource });
  }
  for (const fixture of [...manifest.zitadel.fixtures].reverse()) {
    for (const user of [...fixture.users].reverse()) {
      steps.push({ provider: "zitadel", resourceType: "user", fixtureSlug: fixture.slug, resource: user });
    }
    if (fixture.projectId) {
      steps.push({
        provider: "zitadel",
        resourceType: "project",
        fixtureSlug: fixture.slug,
        projectId: fixture.projectId,
        projectName: fixture.projectName
      });
    }
  }
  return steps;
}

export class CleanupManifestStore {
  private manifest: CleanupResourceManifest;

  constructor(readonly path: string, readonly slug: string) {
    this.manifest = loadResourceManifest(path, slug);
    saveResourceManifest(this.path, this.manifest);
  }

  snapshot(): CleanupResourceManifest {
    return this.manifest;
  }

  recordHetznerSshKey(resource: Timestamped<HetznerSshKeyResource>): void {
    this.update(recordHetznerSshKey(this.manifest, resource));
  }

  removeHetznerSshKey(id: number): void {
    this.update(removeHetznerSshKey(this.manifest, id));
  }

  recordHetznerServer(resource: Timestamped<HetznerServerResource>): void {
    this.update(recordHetznerServer(this.manifest, resource));
  }

  removeHetznerServer(id: number): void {
    this.update(removeHetznerServer(this.manifest, id));
  }

  recordHetznerVolume(resource: Timestamped<HetznerVolumeResource>): void {
    this.update(recordHetznerVolume(this.manifest, resource));
  }

  removeHetznerVolume(id: number): void {
    this.update(removeHetznerVolume(this.manifest, id));
  }

  recordZitadelFixtureProject(resource: Parameters<typeof recordZitadelFixtureProject>[1]): void {
    this.update(recordZitadelFixtureProject(this.manifest, resource));
  }

  recordZitadelFixtureApp(resource: Parameters<typeof recordZitadelFixtureApp>[1]): void {
    this.update(recordZitadelFixtureApp(this.manifest, resource));
  }

  removeZitadelFixtureApp(slug: string): void {
    this.update(removeZitadelFixtureApp(this.manifest, slug));
  }

  recordZitadelFixtureUser(resource: Parameters<typeof recordZitadelFixtureUser>[1]): void {
    this.update(recordZitadelFixtureUser(this.manifest, resource));
  }

  removeZitadelFixtureUser(slug: string, userId: string): void {
    this.update(removeZitadelFixtureUser(this.manifest, slug, userId));
  }

  removeZitadelFixtureProject(slug: string): void {
    this.update(removeZitadelFixtureProject(this.manifest, slug));
  }

  private update(manifest: CleanupResourceManifest): void {
    this.manifest = manifest;
    saveResourceManifest(this.path, this.manifest);
  }
}
