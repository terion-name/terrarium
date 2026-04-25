import { IntegrationContext } from "../context";
import { ExternalOidcFixture } from "../types";
import { buildRouteAuthRedirectUris } from "../../../scripts/terrarium-traefik-sync";
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
import { expectHttpBodyContains, waitForHttpStatusInsecure } from "../assertions/http";

/** Runs the high-signal real-infra smoke suite on one primary and one replica host. */
export async function runSmokeSuite(context: IntegrationContext): Promise<void> {
  await context.zitadelCloud.verifyManagementAccess();
  const sshKeyId = await context.registerHetznerKey(`terrarium-${context.config.slug}`);
  const primaryDomains = context.domainBundle("primary");
  const replicaDomains = context.domainBundle("replica");
  const syncoidTargetDataset = `terrarium/replicated-${context.config.slug}`;
  const primary = await provisionHost(context, { label: "primary", domains: primaryDomains, withVolume: true }, sshKeyId);
  const replica = await provisionHost(context, { label: "replica", domains: replicaDomains, withVolume: false }, sshKeyId);
  const primarySsh = context.ssh(primary);
  const replicaSsh = context.ssh(replica);
  const rootDomain = context.duckdns.rootDomain();

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

    await installSyncoidKey(primarySsh, context.config.sshPrivateKey, context.config.sshPublicKey, replica.server.ipv4);

    await installTerrarium(context, primary, {
      idpMode: "local",
      storageMode: "disk",
      storageSource: primary.volume?.linuxDevice || "/dev/disk/by-id/scsi-0HC_Volume_unknown",
      enableS3: true,
      enableSyncoid: true,
      syncoidTarget: `root@${replica.server.ipv4}`,
      syncoidTargetDataset,
      syncoidSshKey: "/root/.ssh/id_ed25519"
    });

    await assertInstalledHost(primarySsh);
    await assertInstalledHost(replicaSsh);
    await waitForTerrariumPublicEndpoints(primary, true);

    const localAdmin = await readLocalZitadelAdmin(primarySsh);
    await verifyManagementUi(context, primary, localAdmin);

    const plainRoute = `https://plain-${context.config.slug}.${rootDomain}:8080`;
    const authRoute = `https://auth-${context.config.slug}.${rootDomain}:8080@auth`;
    await createHttpFixtureContainer(primarySsh, `proxy-${context.config.slug}`, [plainRoute, authRoute], "terrarium-proxy-ok");
    await expectHttpBodyContains(`https://plain-${context.config.slug}.${rootDomain}`, "terrarium-proxy-ok", {
      resolveIp: primary.server.ipv4
    });
    await waitForHttpStatusInsecure(`https://auth-${context.config.slug}.${rootDomain}`, [302], {
      resolveIp: primary.server.ipv4
    });
    await verifyLocalBackupRestore(primarySsh, `proxy-${context.config.slug}`);
    await verifyS3BackupRestore(primarySsh, `proxy-${context.config.slug}`);
    await verifySyncoid(primarySsh, replicaSsh, syncoidTargetDataset);

    const externalRouteLabels = [
      `https://auth-${context.config.slug}.${rootDomain}:8080@auth`,
      `https://group-${context.config.slug}.${rootDomain}:8080@auth:agents,admins`
    ];
    const { redirectUris: routeCallbackUris, errors: routeCallbackErrors } = buildRouteAuthRedirectUris(externalRouteLabels, {
      terrarium_root_domain: rootDomain,
      terrarium_manage_domain: primary.domains.manage,
      terrarium_proxy_domain: primary.domains.proxy,
      terrarium_auth_domain: primary.domains.auth
    });
    if (routeCallbackErrors.length > 0) {
      throw new Error(`failed to build route auth callback URIs: ${routeCallbackErrors.join("; ")}`);
    }
    const externalFixture: ExternalOidcFixture = await context.provisionZitadelFixture(
      context.config.slug,
      primary.domains,
      "terrarium-admins",
      routeCallbackUris
    );
    await switchToExternalOidc(context, primary, externalFixture);

    await createHttpFixtureContainer(
      primarySsh,
      `proxy-${context.config.slug}`,
      [
        `https://plain-${context.config.slug}.${rootDomain}:8080`,
        ...externalRouteLabels
      ],
      "terrarium-proxy-ok"
    );
    await verifyProtectedRoutes(
      context,
      primary,
      externalFixture,
      `plain-${context.config.slug}.${rootDomain}`,
      `auth-${context.config.slug}.${rootDomain}`,
      `group-${context.config.slug}.${rootDomain}`,
      "terrarium-proxy-ok"
    );

    await switchBackToLocalIdp(context, primary);
    await exerciseReconfiguration(context, primary);
  } catch (error) {
    await captureFailureArtifacts(context, [primary, replica]);
    throw error;
  }
}
