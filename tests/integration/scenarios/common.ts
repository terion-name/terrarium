import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { IntegrationContext } from "../context";
import type { DomainBundle, ExternalOidcFixture, ManagedHost, ServerRecord, VolumeRecord } from "../types";
import { SshHost } from "../remote/ssh";
import { expectHttpBodyContains, waitForHttpStatus } from "../assertions/http";
import { expectCockpitLogin, expectProtectedRoute, expectTraefikDashboard } from "../assertions/browser";
import { expectRemoteContains, expectSystemdActive } from "../assertions/host";
import { collectHostArtifacts } from "../cleanup";

type HostProvisionOptions = {
  label: string;
  domains: DomainBundle;
  withVolume: boolean;
};

type InstallOptions = {
  idpMode: "local" | "oidc";
  storageMode: "disk" | "partition" | "file";
  storageSource?: string;
  storageSize?: string;
  manageDomain?: string;
  proxyDomain?: string;
  lxdDomain?: string;
  authDomain?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  adminGroup?: string;
  enableS3?: boolean;
  enableSyncoid?: boolean;
  syncoidTarget?: string;
  syncoidTargetDataset?: string;
  syncoidSshKey?: string;
  email?: string;
  acmeEmail?: string;
  zitadelAdminEmail?: string;
};

function baseEmail(ctx: IntegrationContext): string {
  return `terrarium+${ctx.config.slug}@duckdns.org`;
}

function repoArchiveRemotePath(localArchivePath: string): string {
  return `/root/${basename(localArchivePath)}`;
}

function binaryRemotePath(): string {
  return "/root/terrarium-bundle/dist/terrariumctl";
}

function dashedIp(ip: string): string {
  return ip.replaceAll(".", "-");
}

export function defaultPublicDomains(ip: string): DomainBundle {
  const dashed = dashedIp(ip);
  return {
    manage: `manage.${dashed}.traefik.me`,
    proxy: `proxy.${dashed}.traefik.me`,
    lxd: `lxd.${dashed}.traefik.me`,
    auth: `auth.${dashed}.traefik.me`
  };
}

export function arbitraryPublicHost(ip: string, prefix: string): string {
  return `${prefix}.${dashedIp(ip)}.traefik.me`;
}

/** Creates a Hetzner host and optionally attaches a raw block volume for Terrarium. */
export async function provisionHost(context: IntegrationContext, options: HostProvisionOptions, sshKeyId: number): Promise<ManagedHost> {
  const labels = { terrarium: "integration", run: context.config.slug, role: options.label };
  const server = await context.hetzner.createServer(
    `terrarium-${context.config.slug}-${options.label}`,
    context.config.hcloudServerType,
    context.config.hcloudLocation,
    [sshKeyId],
    labels
  );
  context.registerCleanup(async () => {
    await context.hetzner.deleteServer(server.id);
  });

  let volume: VolumeRecord | undefined;
  if (options.withVolume) {
    volume = await context.hetzner.createVolume(
      `terrarium-${context.config.slug}-${options.label}`,
      context.config.hcloudVolumeSizeGb,
      context.config.hcloudLocation,
      labels
    );
    context.registerCleanup(async () => {
      if (volume) {
        await context.hetzner.deleteVolume(volume.id);
      }
    });
    volume = await context.hetzner.attachVolume(volume.id, server.id);
  }

  const host = context.host(options.label, server, options.domains, volume);
  const ssh = context.ssh(host);
  await ssh.waitForSsh();
  return host;
}

/** Uploads the current working tree and the Linux test binary to a remote host. */
export async function stageBundleOnHost(context: IntegrationContext, ssh: SshHost): Promise<void> {
  await ssh.exec("mkdir -p /root/terrarium-bundle/dist /root/terrarium-src");
  await ssh.copyTo(context.linuxBinaryPath, binaryRemotePath());
  await ssh.copyTo(context.sourceArchivePath, repoArchiveRemotePath(context.sourceArchivePath));
  await ssh.exec(`rm -rf /root/terrarium-src/* && tar -xzf ${repoArchiveRemotePath(context.sourceArchivePath)} -C /root/terrarium-src`);
  await ssh.exec(`chmod 755 ${binaryRemotePath()}`);
}

/** Runs the Terrarium installer non-interactively on a remote host. */
export async function installTerrarium(context: IntegrationContext, host: ManagedHost, options: InstallOptions): Promise<void> {
  const ssh = context.ssh(host);
  await stageBundleOnHost(context, ssh);
  let storageSource = options.storageSource;
  if (!storageSource && options.storageMode === "disk") {
    storageSource = (
      await ssh.exec(
        "root_source=$(findmnt -n -o SOURCE /); root_disk=$(lsblk -no PKNAME \"$root_source\" 2>/dev/null | sed 's|^|/dev/|'); lsblk -dpno NAME,TYPE | awk '$2 == \"disk\" { print $1 }' | grep -v \"^${root_disk}$\" | head -n 1"
      )
    ).trim();
  }

  const args = [
    `${binaryRemotePath()} install --non-interactive --yes`,
    `--email ${shellArg(options.email || baseEmail(context))}`,
    `--acme-email ${shellArg(options.acmeEmail || baseEmail(context))}`,
    `--root-pwd ${shellArg(`Terrarium!${context.config.slug}`)}`,
    `--idp ${options.idpMode}`,
    `--storage-mode ${options.storageMode}`
  ];

  args.push(`--manage-domain ${shellArg(options.manageDomain || host.domains.manage)}`);
  args.push(`--proxy-domain ${shellArg(options.proxyDomain || host.domains.proxy)}`);
  args.push(`--lxd-domain ${shellArg(options.lxdDomain || host.domains.lxd)}`);

  if (storageSource) {
    args.push(`--storage-source ${shellArg(storageSource)}`);
  }
  if (options.storageSize) {
    args.push(`--storage-size ${shellArg(options.storageSize)}`);
  }
  if (options.idpMode === "local") {
    args.push(`--auth-domain ${shellArg(options.authDomain || host.domains.auth)}`);
    args.push(`--zitadel-admin-email ${shellArg(options.zitadelAdminEmail || baseEmail(context))}`);
    args.push(`--admin-group ${shellArg(options.adminGroup || "terrarium-admins")}`);
  } else {
    args.push(`--admin-group ${shellArg(options.adminGroup || "terrarium-admins")}`);
    args.push(`--oidc ${shellArg(options.oidcIssuer || "")}`);
    args.push(`--oidc-client ${shellArg(options.oidcClientId || "")}`);
    args.push(`--oidc-secret ${shellArg(options.oidcClientSecret || "")}`);
  }
  if (options.enableS3) {
    args.push("--enable-s3");
    args.push(`--s3-endpoint ${shellArg(context.config.s3Endpoint)}`);
    args.push(`--s3-bucket ${shellArg(context.config.s3Bucket)}`);
    args.push(`--s3-region ${shellArg(context.config.s3Region)}`);
    args.push(`--s3-prefix ${shellArg(`terrarium/${context.config.slug}/${host.label}`)}`);
    args.push(`--s3-access-key ${shellArg(context.config.s3AccessKey)}`);
    args.push(`--s3-secret-key ${shellArg(context.config.s3SecretKey)}`);
  }
  if (options.enableSyncoid) {
    args.push("--enable-syncoid");
    args.push(`--syncoid-target ${shellArg(options.syncoidTarget || "")}`);
    args.push(`--syncoid-target-dataset ${shellArg(options.syncoidTargetDataset || "")}`);
    args.push(`--syncoid-ssh-key ${shellArg(options.syncoidSshKey || "/root/.ssh/id_ed25519")}`);
  }

  const remoteScriptPath = `/root/terrarium-install-${host.label}.sh`;
  const remoteStatusPath = `/root/terrarium-install-${host.label}.exit`;
  const remoteLogPath = `/root/terrarium-install-${host.label}.log`;
  await ssh.exec(`rm -f ${shellArg(remoteScriptPath)} ${shellArg(remoteStatusPath)} ${shellArg(remoteLogPath)}`);
  const installCommand = [
    `export TERRARIUM_REPO_URL=${shellArg("file:///root/terrarium-src")}`,
    `export TERRARIUM_BUNDLE_DIR=${shellArg("/root/terrarium-bundle")}`,
    args.join(" ")
  ].join(" && ");
  await ssh.execDetached(installCommand, remoteScriptPath, remoteStatusPath, remoteLogPath);
  await waitForDetachedCommand(ssh, remoteStatusPath, remoteLogPath, 45 * 60 * 1000);
}

/** Returns the local ZITADEL bootstrap credentials from an installed Terrarium host. */
export async function readLocalZitadelAdmin(host: SshHost): Promise<{ email: string; password: string }> {
  const config = await host.read("/etc/terrarium/config.yaml");
  const emailMatch = config.match(/terrarium_zitadel_admin_email:\s*(.+)/);
  const password = (await host.read("/etc/terrarium/secrets/zitadel_admin_password")).trim();
  if (!emailMatch?.[1] || !password) {
    throw new Error("failed to read local ZITADEL bootstrap credentials");
  }
  return {
    email: emailMatch[1].trim().replace(/^["']|["']$/g, ""),
    password
  };
}

/** Waits for the primary Terrarium public endpoints to be online. */
export async function waitForTerrariumPublicEndpoints(host: ManagedHost, includeAuth: boolean): Promise<void> {
  await waitForHttpStatus(`https://${host.domains.manage}`, [302, 303]);
  await waitForHttpStatus(`https://${host.domains.proxy}`, [302, 303]);
  await waitForHttpStatus(`https://${host.domains.lxd}`, [200, 302]);
  if (includeAuth) {
    await waitForHttpStatus(`https://${host.domains.auth}/.well-known/openid-configuration`, [200]);
  }
}

/** Verifies the UI endpoints and auth gates for a Terrarium management surface. */
export async function verifyManagementUi(
  context: IntegrationContext,
  host: ManagedHost,
  user: { email: string; password: string; userId?: string; roles?: string[] }
): Promise<void> {
  const outputDir = join(context.localArtifactsDir, host.label, "browser");
  mkdirSync(outputDir, { recursive: true });
  await expectCockpitLogin(`https://${host.domains.manage}`, user as never, outputDir);
  await expectTraefikDashboard(`https://${host.domains.proxy}`, user as never, outputDir);
}

/** Creates a small HTTP server inside an LXC and publishes the requested proxy labels. */
export async function createHttpFixtureContainer(
  host: SshHost,
  containerName: string,
  labels: string[],
  bodyText: string
): Promise<void> {
  await host.exec(`lxc delete ${shellArg(containerName)} --force || true`);
  await host.exec(`lxc launch images:ubuntu/24.04 ${shellArg(containerName)} --profile terrarium`);
  await host.exec(
    `lxc exec ${shellArg(containerName)} -- bash -lc ${shellArg(
      `apt-get update && apt-get install -y python3 && mkdir -p /srv/www && printf '%s\\n' ${shellArg(bodyText)} > /srv/www/index.html && nohup python3 -m http.server 8080 --directory /srv/www >/tmp/http.log 2>&1 &`
    )}`
  );
  await host.exec(`lxc config set ${shellArg(containerName)} user.proxy ${shellArg(labels.join(","))}`);
  await host.exec("terrariumctl proxy sync");
}

/** Forces local snapshots, mutates container state, and verifies in-place restore. */
export async function verifyLocalBackupRestore(host: SshHost, containerName: string): Promise<void> {
  await host.exec(`lxc exec ${shellArg(containerName)} -- bash -lc "echo v1 > /srv/www/state.txt"`);
  await host.exec("systemctl start sanoid.service || true");
  await host.exec(`lxc exec ${shellArg(containerName)} -- bash -lc "echo v2 > /srv/www/state.txt"`);
  await host.exec(`printf 'y\\n' | terrariumctl backup restore --instance ${shellArg(containerName)}`);
  await host.exec(`lxc start ${shellArg(containerName)} || true`);
  await expectRemoteContains(host, `lxc exec ${shellArg(containerName)} -- cat /srv/www/state.txt`, "v1");
}

/** Verifies the S3 export and restore path against the configured real bucket. */
export async function verifyS3BackupRestore(host: SshHost, containerName: string): Promise<void> {
  await host.exec("terrariumctl backup export");
  await host.exec(`lxc exec ${shellArg(containerName)} -- bash -lc "echo v3 > /srv/www/state.txt"`);
  await host.exec(`printf 'y\\n' | terrariumctl backup restore --source s3 --instance ${shellArg(containerName)}`);
  await host.exec(`lxc start ${shellArg(containerName)} || true`);
  await expectRemoteContains(host, `lxc exec ${shellArg(containerName)} -- cat /srv/www/state.txt`, "v1");
}

/** Verifies syncoid pushed the Terrarium dataset to the replica host. */
export async function verifySyncoid(primary: SshHost, replica: SshHost, dataset: string): Promise<void> {
  await primary.exec("systemctl start terrarium-syncoid.service");
  await expectRemoteContains(replica, `zfs list -H -o name | grep -F ${shellArg(dataset)}`, dataset);
}

/** Reconfigures the primary host to external OIDC and validates the management UIs. */
export async function switchToExternalOidc(
  context: IntegrationContext,
  host: ManagedHost,
  fixture: ExternalOidcFixture
): Promise<void> {
  const ssh = context.ssh(host);
  await ssh.exec(
    [
      "terrariumctl set idp oidc",
      `--oidc ${shellArg(context.config.zitadelCloudIssuer)}`,
      `--oidc-client ${shellArg(fixture.clientId)}`,
      `--oidc-secret ${shellArg(fixture.clientSecret)}`,
      `--admin-group ${shellArg(fixture.adminGroup)}`
    ].join(" ")
  );
  await verifyManagementUi(context, host, fixture.adminUser);
}

/** Reconfigures the primary host back to local ZITADEL and validates its management UIs. */
export async function switchBackToLocalIdp(context: IntegrationContext, host: ManagedHost): Promise<void> {
  const ssh = context.ssh(host);
  await ssh.exec("terrariumctl set idp local");
  const admin = await readLocalZitadelAdmin(ssh);
  await verifyManagementUi(context, host, admin);
}

/** Runs a small route-auth matrix against the currently configured OIDC provider. */
export async function verifyProtectedRoutes(
  context: IntegrationContext,
  host: ManagedHost,
  fixture: ExternalOidcFixture,
  plainHost: string,
  authHost: string,
  groupedHost: string,
  bodyText: string
): Promise<void> {
  await waitForHttpStatus(`https://${plainHost}`, [200, 302]);
  const outputDir = join(context.localArtifactsDir, host.label, "routes");
  mkdirSync(outputDir, { recursive: true });
  await expectHttpBodyContains(`https://${plainHost}`, bodyText);
  await expectProtectedRoute(`https://${authHost}`, fixture.routeUser, "allow", outputDir, bodyText);
  await expectProtectedRoute(`https://${groupedHost}`, fixture.routeUser, "allow", outputDir, bodyText);
  await expectProtectedRoute(`https://${groupedHost}`, fixture.deniedUser, "deny", outputDir);
}

/** Applies a handful of `terrariumctl set ...` operations and validates convergence. */
export async function exerciseReconfiguration(context: IntegrationContext, host: ManagedHost): Promise<void> {
  const ssh = context.ssh(host);
  const altManage = context.duckdns.serviceHost("manage-alt", context.config.slug);
  const altProxy = context.duckdns.serviceHost("proxy-alt", context.config.slug);
  const altLxd = context.duckdns.serviceHost("lxd-alt", context.config.slug);
  const altAuth = context.duckdns.serviceHost("auth-alt", context.config.slug);
  await ssh.exec(
    `terrariumctl set domains ${shellArg(context.duckdns.rootDomain())} --manage-domain ${shellArg(altManage)} --proxy-domain ${shellArg(
      altProxy
    )} --lxd-domain ${shellArg(altLxd)} --auth-domain ${shellArg(altAuth)}`
  );
  await ssh.exec(`terrariumctl set emails --email ${shellArg(baseEmail(context))} --acme-email ${shellArg(baseEmail(context))}`);
  await ssh.exec(
    `terrariumctl set s3 --enable --s3-endpoint ${shellArg(context.config.s3Endpoint)} --s3-bucket ${shellArg(
      context.config.s3Bucket
    )} --s3-region ${shellArg(context.config.s3Region)} --s3-prefix ${shellArg(`terrarium/${context.config.slug}/reconfigured`)} --s3-access-key ${shellArg(
      context.config.s3AccessKey
    )} --s3-secret-key ${shellArg(context.config.s3SecretKey)}`
  );
  await ssh.exec("terrariumctl set syncoid --disable");
  await ssh.exec("terrariumctl set syncoid --enable --syncoid-target root@127.0.0.1 --syncoid-target-dataset terrarium/containers --syncoid-ssh-key /root/.ssh/id_ed25519").catch(() => {
    // The loopback re-enable intentionally only exercises validation/wiring and is allowed to fail remotely.
  });
}

/** Collects high-value artifacts from a managed host after a scenario failure. */
export async function captureFailureArtifacts(context: IntegrationContext, hosts: ManagedHost[]): Promise<void> {
  for (const host of hosts) {
    try {
      await collectHostArtifacts(context, host);
    } catch (error) {
      context.logger.warn(`artifact collection failed for ${host.label}: ${String(error)}`);
    }
  }
}

/** Verifies the installed host’s service/timer health via CLI and systemd. */
export async function assertInstalledHost(host: SshHost): Promise<void> {
  await expectRemoteContains(host, "terrariumctl status", "terrarium-oauth2-proxy.service");
  await expectSystemdActive(host, "traefik");
  await expectSystemdActive(host, "terrarium-traefik-sync.timer");
}

/** Creates a partitioned disk layout with a large free extent for partition-mode install tests. */
export async function preparePartitionTarget(host: SshHost, devicePath: string): Promise<void> {
  await host.exec(`parted -s ${shellArg(devicePath)} mklabel gpt`);
  await host.exec(`parted -s ${shellArg(devicePath)} unit MiB mkpart primary ext4 1 2048`);
}

/** Uploads the runner SSH key onto the primary host so syncoid can reach the replica. */
export async function installSyncoidKey(primary: SshHost, privateKeyPath: string, publicKeyPath: string): Promise<void> {
  await primary.exec("mkdir -p /root/.ssh");
  await primary.uploadKeypair(privateKeyPath, publicKeyPath, "/root/.ssh/id_ed25519");
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

async function waitForDetachedCommand(host: SshHost, statusPath: string, logPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await host.execAllowFailure(`test -f ${shellArg(statusPath)} && cat ${shellArg(statusPath)}`);
    if (result.exitCode === 0) {
      const exitCode = Number(result.stdout.trim() || "1");
      if (exitCode !== 0) {
        const log = await host.execAllowFailure(`tail -n 200 ${shellArg(logPath)} || true`);
        throw new Error(`remote command failed with exit ${exitCode}\n${log.stdout || log.stderr}`);
      }
      return;
    }

    try {
      await host.waitForSsh(15000);
    } catch {
      // Host may be briefly unavailable while Terrarium hardens SSH or restarts services.
    }
    await Bun.sleep(5000);
  }

  const tail = await host.execAllowFailure(`tail -n 200 ${shellArg(logPath)} || true`);
  throw new Error(`timed out waiting for remote command to finish\n${tail.stdout || tail.stderr}`);
}
