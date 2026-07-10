import type { CleanupStep } from "../resources";
import type { DomainBundle, ExternalOidcFixture, IntegrationIdpProvider } from "../types";

export type IntegrationOidcFixtureUserKind = "adminUser" | "routeUser" | "deniedUser";

export type IntegrationOidcFixtureProgress =
  | {
      type: "project";
      fixtureSlug: string;
      projectId: string;
      projectName: string;
      adminGroup: string;
      routeGroups: string[];
    }
  | {
      type: "app";
      fixtureSlug: string;
      projectId: string;
      appId: string;
      appName: string;
    }
  | {
      type: "user";
      fixtureSlug: string;
      kind: IntegrationOidcFixtureUserKind;
      userId: string;
      email: string;
      roles: string[];
    };

export type IntegrationOidcFixtureProgressHandler = (progress: IntegrationOidcFixtureProgress) => void | Promise<void>;

export type IntegrationOidcFixtureOptions = {
  extraDomains?: DomainBundle[];
};

export type ExternalOidcCleanupStep = Extract<CleanupStep, { provider: "external-oidc" }>;

export interface IntegrationOidcProvider {
  readonly provider: IntegrationIdpProvider;
  readonly issuer: string;

  verifyManagementAccess(): Promise<void>;
  cleanupStaleIntegrationFixtures(): Promise<void>;
  provisionFixture(
    slug: string,
    domains: DomainBundle,
    adminGroup: string,
    routeCallbackUris?: string[],
    options?: IntegrationOidcFixtureOptions,
    onProgress?: IntegrationOidcFixtureProgressHandler
  ): Promise<ExternalOidcFixture>;
  cleanupFixture(fixture: ExternalOidcFixture): Promise<void>;
  deleteFixtureResource(step: ExternalOidcCleanupStep): Promise<void>;

  deleteUser(userId: string): Promise<void>;
  deleteApp(projectId: string, appId: string): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
}
