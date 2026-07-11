import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IntegrationIdpProvider } from "./types";

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

export type ExternalOidcFixtureUserResource = {
  kind: string;
  userId: string;
  email: string;
  roles: string[];
  createdAt: string;
};

export type ExternalOidcFixtureApplicationResource = {
  appId: string;
  appName?: string;
  clientId?: string;
  clientName?: string;
  projectId?: string;
  createdAt: string;
};

export type ExternalOidcFixtureRoleResource = {
  roleId: string;
  roleName?: string;
  key?: string;
  createdAt: string;
};

export type ExternalOidcFixtureApiResource = {
  apiResourceId: string;
  apiResourceName?: string;
  audience?: string;
  createdAt: string;
};

export type ExternalOidcFixtureResource = {
  idpProvider: IntegrationIdpProvider;
  slug: string;
  projectId?: string;
  projectName?: string;
  containerId?: string;
  containerName?: string;
  adminGroup?: string;
  routeGroups: string[];
  users: ExternalOidcFixtureUserResource[];
  applications: ExternalOidcFixtureApplicationResource[];
  roles: ExternalOidcFixtureRoleResource[];
  apiResources: ExternalOidcFixtureApiResource[];
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
  externalOidc: {
    fixtures: ExternalOidcFixtureResource[];
  };
  zitadel: {
    fixtures: ZitadelFixtureResource[];
  };
};

export type CleanupStep =
  | { provider: "hetzner"; resourceType: "server"; resource: HetznerServerResource }
  | { provider: "hetzner"; resourceType: "volume"; resource: HetznerVolumeResource }
  | { provider: "hetzner"; resourceType: "ssh-key"; resource: HetznerSshKeyResource }
  | {
      provider: "external-oidc";
      idpProvider: IntegrationIdpProvider;
      resourceType: "user";
      fixtureSlug: string;
      resource: ExternalOidcFixtureUserResource;
    }
  | {
      provider: "external-oidc";
      idpProvider: IntegrationIdpProvider;
      resourceType: "app";
      fixtureSlug: string;
      projectId?: string;
      appId: string;
      appName?: string;
      resource: ExternalOidcFixtureApplicationResource;
    }
  | {
      provider: "external-oidc";
      idpProvider: IntegrationIdpProvider;
      resourceType: "role";
      fixtureSlug: string;
      resource: ExternalOidcFixtureRoleResource;
    }
  | {
      provider: "external-oidc";
      idpProvider: IntegrationIdpProvider;
      resourceType: "api-resource";
      fixtureSlug: string;
      resource: ExternalOidcFixtureApiResource;
    }
  | {
      provider: "external-oidc";
      idpProvider: IntegrationIdpProvider;
      resourceType: "project";
      fixtureSlug: string;
      projectId: string;
      projectName?: string;
      containerId?: string;
      containerName?: string;
    }
  | {
      provider: "external-oidc";
      idpProvider: IntegrationIdpProvider;
      resourceType: "container";
      fixtureSlug: string;
      containerId: string;
      containerName?: string;
    }
;

type Timestamped<T> = Omit<T, "createdAt"> & { createdAt?: string };

type LoadedCleanupResourceManifest = Partial<Omit<CleanupResourceManifest, "version">> & { version?: number };

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
    externalOidc: {
      fixtures: []
    },
    zitadel: {
      fixtures: []
    }
  };
}

function normalizeZitadelFixture(fixture: ZitadelFixtureResource): ZitadelFixtureResource {
  return {
    ...fixture,
    routeGroups: fixture.routeGroups ?? [],
    users: fixture.users ?? []
  };
}

function normalizeExternalOidcFixture(fixture: ExternalOidcFixtureResource): ExternalOidcFixtureResource {
  return {
    ...fixture,
    routeGroups: fixture.routeGroups ?? [],
    users: fixture.users ?? [],
    applications: fixture.applications ?? [],
    roles: fixture.roles ?? [],
    apiResources: fixture.apiResources ?? []
  };
}

function externalOidcFixtureFromLegacyZitadel(fixture: ZitadelFixtureResource): ExternalOidcFixtureResource {
  const normalized = normalizeZitadelFixture(fixture);
  return {
    idpProvider: "zitadel",
    slug: normalized.slug,
    projectId: normalized.projectId,
    projectName: normalized.projectName,
    adminGroup: normalized.adminGroup,
    routeGroups: normalized.routeGroups,
    users: normalized.users,
    applications: normalized.appId
      ? [
          {
            appId: normalized.appId,
            appName: normalized.appName,
            projectId: normalized.projectId,
            createdAt: normalized.createdAt
          }
        ]
      : [],
    roles: [],
    apiResources: [],
    createdAt: normalized.createdAt
  };
}

export function loadResourceManifest(path: string, slug: string): CleanupResourceManifest {
  if (!existsSync(path)) {
    return createEmptyResourceManifest(slug);
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as LoadedCleanupResourceManifest;
  if (parsed.version !== 1) {
    throw new Error(`unsupported cleanup resource manifest version in ${path}`);
  }

  return {
    ...createEmptyResourceManifest(slug),
    ...parsed,
    version: 1,
    hetzner: {
      sshKeys: parsed.hetzner?.sshKeys ?? [],
      servers: parsed.hetzner?.servers ?? [],
      volumes: parsed.hetzner?.volumes ?? []
    },
    externalOidc: {
      fixtures: (parsed.externalOidc?.fixtures ?? []).map(normalizeExternalOidcFixture)
    },
    zitadel: {
      fixtures: (parsed.zitadel?.fixtures ?? []).map(normalizeZitadelFixture)
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

function upsertById<T extends { id: number | string }>(items: T[], resource: T): T[] {
  const withoutExisting = items.filter((item) => item.id !== resource.id);
  return [...withoutExisting, resource];
}

function upsertExternalOidcUser(
  users: ExternalOidcFixtureUserResource[],
  resource: ExternalOidcFixtureUserResource
): ExternalOidcFixtureUserResource[] {
  const withoutExisting = users.filter((user) => user.userId !== resource.userId);
  return [...withoutExisting, resource];
}

function upsertExternalOidcApplication(
  applications: ExternalOidcFixtureApplicationResource[],
  resource: ExternalOidcFixtureApplicationResource
): ExternalOidcFixtureApplicationResource[] {
  const withoutExisting = applications.filter((application) => application.appId !== resource.appId);
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

function upsertExternalOidcFixture(
  manifest: CleanupResourceManifest,
  fixture: ExternalOidcFixtureResource
): CleanupResourceManifest {
  const withoutExisting = manifest.externalOidc.fixtures.filter(
    (item) => item.idpProvider !== fixture.idpProvider || item.slug !== fixture.slug
  );
  return {
    ...manifest,
    externalOidc: {
      fixtures: [...withoutExisting, fixture]
    }
  };
}

function externalOidcFixtureFor(
  manifest: CleanupResourceManifest,
  idpProvider: IntegrationIdpProvider,
  slug: string,
  seed?: Partial<ExternalOidcFixtureResource>
): ExternalOidcFixtureResource {
  const existing = manifest.externalOidc.fixtures.find((fixture) => fixture.idpProvider === idpProvider && fixture.slug === slug);
  return {
    idpProvider,
    slug,
    ...existing,
    ...seed,
    createdAt: resourceTimestamp(existing, seed?.createdAt),
    routeGroups: seed?.routeGroups ?? existing?.routeGroups ?? [],
    users: seed?.users ?? existing?.users ?? [],
    applications: seed?.applications ?? existing?.applications ?? [],
    roles: seed?.roles ?? existing?.roles ?? [],
    apiResources: seed?.apiResources ?? existing?.apiResources ?? []
  };
}

function removeEmptyExternalOidcFixture(
  manifest: CleanupResourceManifest,
  fixture: ExternalOidcFixtureResource
): CleanupResourceManifest {
  const hasProject = Boolean(fixture.projectId || fixture.projectName || fixture.containerId || fixture.containerName);
  const hasResources =
    fixture.users.length > 0 || fixture.applications.length > 0 || fixture.roles.length > 0 || fixture.apiResources.length > 0 || hasProject;
  if (hasResources) {
    return upsertExternalOidcFixture(manifest, fixture);
  }
  return {
    ...manifest,
    externalOidc: {
      fixtures: manifest.externalOidc.fixtures.filter(
        (item) => item.idpProvider !== fixture.idpProvider || item.slug !== fixture.slug
      )
    }
  };
}

export function recordExternalOidcFixtureProject(
  manifest: CleanupResourceManifest,
  resource: {
    idpProvider: IntegrationIdpProvider;
    slug: string;
    projectId?: string;
    projectName?: string;
    containerId?: string;
    containerName?: string;
    adminGroup?: string;
    routeGroups?: string[];
    createdAt?: string;
  }
): CleanupResourceManifest {
  const seed: Partial<ExternalOidcFixtureResource> = {};
  if (resource.projectId !== undefined) seed.projectId = resource.projectId;
  if (resource.projectName !== undefined) seed.projectName = resource.projectName;
  if (resource.containerId !== undefined) seed.containerId = resource.containerId;
  if (resource.containerName !== undefined) seed.containerName = resource.containerName;
  if (resource.adminGroup !== undefined) seed.adminGroup = resource.adminGroup;
  if (resource.routeGroups !== undefined) seed.routeGroups = resource.routeGroups;
  if (resource.createdAt !== undefined) seed.createdAt = resource.createdAt;

  const fixture = externalOidcFixtureFor(manifest, resource.idpProvider, resource.slug, seed);
  return upsertExternalOidcFixture(manifest, fixture);
}

export function removeExternalOidcFixtureProject(
  manifest: CleanupResourceManifest,
  idpProvider: IntegrationIdpProvider,
  slug: string
): CleanupResourceManifest {
  const existing = manifest.externalOidc.fixtures.find((fixture) => fixture.idpProvider === idpProvider && fixture.slug === slug);
  if (!existing) {
    return manifest;
  }
  const {
    projectId: _projectId,
    projectName: _projectName,
    containerId: _containerId,
    containerName: _containerName,
    adminGroup: _adminGroup,
    routeGroups: _routeGroups,
    ...fixture
  } = existing;
  return removeEmptyExternalOidcFixture(manifest, { ...fixture, routeGroups: [] });
}

export function recordExternalOidcFixtureApp(
  manifest: CleanupResourceManifest,
  resource: {
    idpProvider: IntegrationIdpProvider;
    slug: string;
    projectId?: string;
    appId: string;
    appName?: string;
    clientId?: string;
    clientName?: string;
    createdAt?: string;
  }
): CleanupResourceManifest {
  const fixture = externalOidcFixtureFor(manifest, resource.idpProvider, resource.slug);
  const existing = fixture.applications.find((application) => application.appId === resource.appId);
  return upsertExternalOidcFixture(manifest, {
    ...fixture,
    applications: upsertExternalOidcApplication(fixture.applications, {
      appId: resource.appId,
      appName: resource.appName ?? existing?.appName,
      clientId: resource.clientId ?? existing?.clientId,
      clientName: resource.clientName ?? existing?.clientName,
      projectId: resource.projectId ?? existing?.projectId,
      createdAt: resourceTimestamp(existing, resource.createdAt)
    })
  });
}

export function removeExternalOidcFixtureApp(
  manifest: CleanupResourceManifest,
  idpProvider: IntegrationIdpProvider,
  slug: string,
  appId?: string
): CleanupResourceManifest {
  const existing = manifest.externalOidc.fixtures.find((fixture) => fixture.idpProvider === idpProvider && fixture.slug === slug);
  if (!existing) {
    return manifest;
  }
  return removeEmptyExternalOidcFixture(manifest, {
    ...existing,
    applications: appId ? existing.applications.filter((application) => application.appId !== appId) : []
  });
}

export function recordExternalOidcFixtureUser(
  manifest: CleanupResourceManifest,
  resource: {
    idpProvider: IntegrationIdpProvider;
    slug: string;
    kind: string;
    userId: string;
    email: string;
    roles: string[];
    createdAt?: string;
  }
): CleanupResourceManifest {
  const fixture = externalOidcFixtureFor(manifest, resource.idpProvider, resource.slug);
  const existing = fixture.users.find((user) => user.userId === resource.userId);
  return upsertExternalOidcFixture(manifest, {
    ...fixture,
    users: upsertExternalOidcUser(fixture.users, {
      kind: resource.kind,
      userId: resource.userId,
      email: resource.email,
      roles: resource.roles,
      createdAt: resourceTimestamp(existing, resource.createdAt)
    })
  });
}

export function removeExternalOidcFixtureUser(
  manifest: CleanupResourceManifest,
  idpProvider: IntegrationIdpProvider,
  slug: string,
  userId: string
): CleanupResourceManifest {
  const existing = manifest.externalOidc.fixtures.find((fixture) => fixture.idpProvider === idpProvider && fixture.slug === slug);
  if (!existing) {
    return manifest;
  }
  return removeEmptyExternalOidcFixture(manifest, {
    ...existing,
    users: existing.users.filter((user) => user.userId !== userId)
  });
}

export function removeExternalOidcFixtureRole(
  manifest: CleanupResourceManifest,
  idpProvider: IntegrationIdpProvider,
  slug: string,
  roleId: string
): CleanupResourceManifest {
  const existing = manifest.externalOidc.fixtures.find((fixture) => fixture.idpProvider === idpProvider && fixture.slug === slug);
  if (!existing) {
    return manifest;
  }
  return removeEmptyExternalOidcFixture(manifest, {
    ...existing,
    roles: existing.roles.filter((role) => role.roleId !== roleId)
  });
}

export function removeExternalOidcFixtureApiResource(
  manifest: CleanupResourceManifest,
  idpProvider: IntegrationIdpProvider,
  slug: string,
  apiResourceId: string
): CleanupResourceManifest {
  const existing = manifest.externalOidc.fixtures.find((fixture) => fixture.idpProvider === idpProvider && fixture.slug === slug);
  if (!existing) {
    return manifest;
  }
  return removeEmptyExternalOidcFixture(manifest, {
    ...existing,
    apiResources: existing.apiResources.filter((apiResource) => apiResource.apiResourceId !== apiResourceId)
  });
}

export function removeExternalOidcFixtureContainer(
  manifest: CleanupResourceManifest,
  idpProvider: IntegrationIdpProvider,
  slug: string
): CleanupResourceManifest {
  const existing = manifest.externalOidc.fixtures.find((fixture) => fixture.idpProvider === idpProvider && fixture.slug === slug);
  if (!existing) {
    return manifest;
  }
  const { containerId: _containerId, containerName: _containerName, ...fixture } = existing;
  return removeEmptyExternalOidcFixture(manifest, fixture);
}

function pruneLegacyZitadelFixture(manifest: CleanupResourceManifest, slug: string, update: (fixture: ZitadelFixtureResource) => ZitadelFixtureResource | undefined) {
  const fixtures = manifest.zitadel.fixtures.flatMap((fixture) => {
    if (fixture.slug !== slug) {
      return [fixture];
    }
    const updated = update(fixture);
    return updated ? [updated] : [];
  });
  return {
    ...manifest,
    zitadel: { fixtures }
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
  return recordExternalOidcFixtureProject(manifest, {
    idpProvider: "zitadel",
    slug: resource.slug,
    projectId: resource.projectId,
    projectName: resource.projectName,
    adminGroup: resource.adminGroup,
    routeGroups: resource.routeGroups
  });
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
  return recordExternalOidcFixtureApp(manifest, {
    idpProvider: "zitadel",
    slug: resource.slug,
    projectId: resource.projectId,
    appId: resource.appId,
    appName: resource.appName
  });
}

export function removeZitadelFixtureApp(manifest: CleanupResourceManifest, slug: string, appId?: string): CleanupResourceManifest {
  const withoutCurrent = removeExternalOidcFixtureApp(manifest, "zitadel", slug, appId);
  return pruneLegacyZitadelFixture(withoutCurrent, slug, (fixture) => {
    const { appId: _appId, appName: _appName, ...rest } = fixture;
    return rest;
  });
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
  return recordExternalOidcFixtureUser(manifest, {
    idpProvider: "zitadel",
    slug: resource.slug,
    kind: resource.kind,
    userId: resource.userId,
    email: resource.email,
    roles: resource.roles,
    createdAt: resource.createdAt
  });
}

export function removeZitadelFixtureUser(manifest: CleanupResourceManifest, slug: string, userId: string): CleanupResourceManifest {
  const withoutCurrent = removeExternalOidcFixtureUser(manifest, "zitadel", slug, userId);
  return pruneLegacyZitadelFixture(withoutCurrent, slug, (fixture) => ({
    ...fixture,
    users: fixture.users.filter((user) => user.userId !== userId)
  }));
}

export function removeZitadelFixtureProject(manifest: CleanupResourceManifest, slug: string): CleanupResourceManifest {
  let withoutCurrent = removeExternalOidcFixtureProject(manifest, "zitadel", slug);
  const currentFixture = withoutCurrent.externalOidc.fixtures.find(
    (fixture) => fixture.idpProvider === "zitadel" && fixture.slug === slug
  );
  if (currentFixture) {
    withoutCurrent = removeEmptyExternalOidcFixture(withoutCurrent, {
      ...currentFixture,
      applications: [],
      roles: [],
      apiResources: [],
      routeGroups: []
    });
  }
  return pruneLegacyZitadelFixture(withoutCurrent, slug, (fixture) => {
    if (fixture.users.length > 0) {
      const {
        appId: _appId,
        appName: _appName,
        projectId: _projectId,
        projectName: _projectName,
        adminGroup: _adminGroup,
        routeGroups: _routeGroups,
        ...rest
      } = fixture;
      return { ...rest, routeGroups: [] };
    }
    return undefined;
  });
}

function externalOidcFixturesForPlan(manifest: CleanupResourceManifest): ExternalOidcFixtureResource[] {
  return [
    ...manifest.externalOidc.fixtures.map(normalizeExternalOidcFixture),
    ...manifest.zitadel.fixtures.map(externalOidcFixtureFromLegacyZitadel)
  ];
}

function projectCleanupFixtures(fixtures: ExternalOidcFixtureResource[]): ExternalOidcFixtureResource[] {
  const reversed = [...fixtures].reverse();
  return [...reversed.filter((fixture) => fixture.idpProvider !== "zitadel"), ...reversed.filter((fixture) => fixture.idpProvider === "zitadel")];
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

  const externalOidcFixtures = externalOidcFixturesForPlan(manifest);
  for (const fixture of [...externalOidcFixtures].reverse()) {
    for (const user of [...fixture.users].reverse()) {
      steps.push({
        provider: "external-oidc",
        idpProvider: fixture.idpProvider,
        resourceType: "user",
        fixtureSlug: fixture.slug,
        resource: user
      });
    }
  }
  for (const fixture of [...externalOidcFixtures].reverse()) {
    if (fixture.idpProvider === "zitadel" && fixture.projectId) {
      continue;
    }
    for (const application of [...fixture.applications].reverse()) {
      steps.push({
        provider: "external-oidc",
        idpProvider: fixture.idpProvider,
        resourceType: "app",
        fixtureSlug: fixture.slug,
        projectId: application.projectId ?? fixture.projectId,
        appId: application.appId,
        appName: application.appName,
        resource: application
      });
    }
  }
  for (const fixture of [...externalOidcFixtures].reverse()) {
    for (const role of [...fixture.roles].reverse()) {
      steps.push({
        provider: "external-oidc",
        idpProvider: fixture.idpProvider,
        resourceType: "role",
        fixtureSlug: fixture.slug,
        resource: role
      });
    }
    for (const apiResource of [...fixture.apiResources].reverse()) {
      steps.push({
        provider: "external-oidc",
        idpProvider: fixture.idpProvider,
        resourceType: "api-resource",
        fixtureSlug: fixture.slug,
        resource: apiResource
      });
    }
  }
  for (const fixture of projectCleanupFixtures(externalOidcFixtures)) {
    if (fixture.projectId) {
      steps.push({
        provider: "external-oidc",
        idpProvider: fixture.idpProvider,
        resourceType: "project",
        fixtureSlug: fixture.slug,
        projectId: fixture.projectId,
        projectName: fixture.projectName,
        containerId: fixture.containerId,
        containerName: fixture.containerName
      });
      continue;
    }
    if (fixture.containerId) {
      steps.push({
        provider: "external-oidc",
        idpProvider: fixture.idpProvider,
        resourceType: "container",
        fixtureSlug: fixture.slug,
        containerId: fixture.containerId,
        containerName: fixture.containerName
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

  recordExternalOidcFixtureProject(resource: Parameters<typeof recordExternalOidcFixtureProject>[1]): void {
    this.update(recordExternalOidcFixtureProject(this.manifest, resource));
  }

  removeExternalOidcFixtureProject(idpProvider: IntegrationIdpProvider, slug: string): void {
    this.update(removeExternalOidcFixtureProject(this.manifest, idpProvider, slug));
  }

  recordExternalOidcFixtureApp(resource: Parameters<typeof recordExternalOidcFixtureApp>[1]): void {
    this.update(recordExternalOidcFixtureApp(this.manifest, resource));
  }

  removeExternalOidcFixtureApp(idpProvider: IntegrationIdpProvider, slug: string, appId?: string): void {
    this.update(removeExternalOidcFixtureApp(this.manifest, idpProvider, slug, appId));
  }

  recordExternalOidcFixtureUser(resource: Parameters<typeof recordExternalOidcFixtureUser>[1]): void {
    this.update(recordExternalOidcFixtureUser(this.manifest, resource));
  }

  removeExternalOidcFixtureUser(idpProvider: IntegrationIdpProvider, slug: string, userId: string): void {
    this.update(removeExternalOidcFixtureUser(this.manifest, idpProvider, slug, userId));
  }

  removeExternalOidcFixtureRole(idpProvider: IntegrationIdpProvider, slug: string, roleId: string): void {
    this.update(removeExternalOidcFixtureRole(this.manifest, idpProvider, slug, roleId));
  }

  removeExternalOidcFixtureApiResource(idpProvider: IntegrationIdpProvider, slug: string, apiResourceId: string): void {
    this.update(removeExternalOidcFixtureApiResource(this.manifest, idpProvider, slug, apiResourceId));
  }

  removeExternalOidcFixtureContainer(idpProvider: IntegrationIdpProvider, slug: string): void {
    this.update(removeExternalOidcFixtureContainer(this.manifest, idpProvider, slug));
  }

  recordZitadelFixtureProject(resource: Parameters<typeof recordZitadelFixtureProject>[1]): void {
    this.update(recordZitadelFixtureProject(this.manifest, resource));
  }

  recordZitadelFixtureApp(resource: Parameters<typeof recordZitadelFixtureApp>[1]): void {
    this.update(recordZitadelFixtureApp(this.manifest, resource));
  }

  removeZitadelFixtureApp(slug: string, appId?: string): void {
    this.update(removeZitadelFixtureApp(this.manifest, slug, appId));
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
