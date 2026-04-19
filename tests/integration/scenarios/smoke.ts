import { join } from "node:path";
import { IntegrationContext } from "../context";
import { ExternalOidcFixture } from "../types";
import {
  assertInstalledHost,
  captureFailureArtifacts,
  createHttpFixtureContainer,
  exerciseReconfiguration,
  installSyncoidKey,
  installTerrarium,
  provisionHost,
  readLocalZitadelAdmin,
  switchBackToLocalIdp,
  switchToExternalOidc,
  verifyLocalBackupRestore,
  verifyManagementUi,
  verifyProtectedRoutes,
  verifyS3BackupRestore,
  verifySyncoid,
  waitForTerrariumPublicEndpoints
} from "./common";
import { expectHttpBodyContains } from "../assertions/http";
import { expectProtectedRoute } from "../assertions/browser";

/** Runs the high-signal real-infra smoke suite on one primary and one replica host. */
export async function runSmokeSuite(context: IntegrationContext): Promise<void> {
  const sshKeyId = await context.registerHetznerKey(`terrarium-${context.config.slug}`);
  const primaryDomains = context.domainBundle("primary");
  const replicaDomains = context.domainBundle("replica");
  const primary = await provisionHost(context, { label: "primary", domains: primaryDomains, withVolume: true }, sshKeyId);
  const replica = await provisionHost(context, { label: "replica", domains: replicaDomains, withVolume: false }, sshKeyId);
  const primarySsh = context.ssh(primary);
  const replicaSsh = context.ssh(replica);

  try {
    await context.duckdns.update(replica.server.ipv4);
    await context.duckdns.waitForHosts(
      [replica.domains.manage, replica.domains.proxy, replica.domains.lxd, replica.domains.auth],
      replica.server.ipv4
    );

    await installTerrarium(context, replica, {
      idpMode: "local",
      storageMode: "file",
      storageSize: "32G"
    });

    await context.duckdns.update(primary.server.ipv4);
    await context.duckdns.waitForHosts(
      [primary.domains.manage, primary.domains.proxy, primary.domains.lxd, primary.domains.auth],
      primary.server.ipv4
    );

    await installSyncoidKey(primarySsh, context.config.sshPrivateKey, context.config.sshPublicKey);

    await installTerrarium(context, primary, {
      idpMode: "local",
      storageMode: "disk",
      storageSource: primary.volume?.linuxDevice || "/dev/disk/by-id/scsi-0HC_Volume_unknown",
      enableS3: true,
      enableSyncoid: true,
      syncoidTarget: `root@${replica.server.ipv4}`,
      syncoidTargetDataset: "terrarium/containers",
      syncoidSshKey: "/root/.ssh/id_ed25519"
    });

    await assertInstalledHost(primarySsh);
    await assertInstalledHost(replicaSsh);
    await waitForTerrariumPublicEndpoints(primary, true);

    const localAdmin = await readLocalZitadelAdmin(primarySsh);
    await verifyManagementUi(context, primary, localAdmin);

    const plainRoute = `https://plain-${context.config.slug}.${context.duckdns.rootDomain()}`;
    const authRoute = `https://auth-${context.config.slug}.${context.duckdns.rootDomain()}@auth`;
    await createHttpFixtureContainer(primarySsh, `proxy-${context.config.slug}`, [plainRoute, authRoute], "terrarium-proxy-ok");
    await expectHttpBodyContains(`https://plain-${context.config.slug}.${context.duckdns.rootDomain()}`, "terrarium-proxy-ok");
    await expectProtectedRoute(
      `https://auth-${context.config.slug}.${context.duckdns.rootDomain()}`,
      localAdmin as never,
      "allow",
      join(context.localArtifactsDir, primary.label, "local-routes"),
      "terrarium-proxy-ok"
    );
    await verifyLocalBackupRestore(primarySsh, `proxy-${context.config.slug}`);
    await verifyS3BackupRestore(primarySsh, `proxy-${context.config.slug}`);
    await verifySyncoid(primarySsh, replicaSsh, "terrarium/containers");

    const externalFixture: ExternalOidcFixture = await context.zitadelCloud.provisionFixture(context.config.slug, primary.domains, "terrarium-admins");
    context.registerCleanup(async () => {
      await context.zitadelCloud.cleanupFixture(externalFixture);
    });
    await switchToExternalOidc(context, primary, externalFixture);

    await createHttpFixtureContainer(
      primarySsh,
      `proxy-${context.config.slug}`,
      [
        `https://plain-${context.config.slug}.${context.duckdns.rootDomain()}`,
        `https://auth-${context.config.slug}.${context.duckdns.rootDomain()}@auth`,
        `https://group-${context.config.slug}.${context.duckdns.rootDomain()}@auth:agents,admins`
      ],
      "terrarium-proxy-ok"
    );
    await verifyProtectedRoutes(
      context,
      primary,
      externalFixture,
      `plain-${context.config.slug}.${context.duckdns.rootDomain()}`,
      `auth-${context.config.slug}.${context.duckdns.rootDomain()}`,
      `group-${context.config.slug}.${context.duckdns.rootDomain()}`,
      "terrarium-proxy-ok"
    );

    await switchBackToLocalIdp(context, primary);
    await exerciseReconfiguration(context, primary);
  } catch (error) {
    await captureFailureArtifacts(context, [primary, replica]);
    throw error;
  }
}
