import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { IntegrationContext } from "../context";
import type { ExternalOidcFixture, ManagedHost, VolumeRecord } from "../types";
import { SshHost } from "../remote/ssh";
import { expectHttpBodyContains, expectHttpsJson, waitForHttpStatusResolved } from "../assertions/http";
import { expectLxdUi, expectManagementSurfaces, expectManagementUi, expectProtectedRoute } from "../assertions/browser";
import { expectRemoteContains, expectSystemdActive } from "../assertions/host";
import { collectHostArtifacts } from "../cleanup";

type HostProvisionOptions = {
  label: string;
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
  lxdOidcClientId?: string;
  lxdOidcClientSecret?: string;
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
  return `terrarium+${ctx.config.slug}@${ctx.config.ipDnsDomain}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repoArchiveRemotePath(localArchivePath: string): string {
  return `/root/${basename(localArchivePath)}`;
}

function binaryRemotePath(): string {
  return "/root/terrarium-bundle/dist/terrariumctl";
}

function remoteCtl(command: string): string {
  return `/usr/local/bin/terrariumctl ${command}`;
}

export async function uploadSecretFile(ssh: SshHost, remotePath: string, secret: string): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), "terrarium-secret-"));
  const localPath = join(tempDir, "secret");
  try {
    writeFileSync(localPath, `${secret.replace(/\n+$/g, "")}\n`, { encoding: "utf8", mode: 0o600 });
    await ssh.copyTo(localPath, remotePath);
    await ssh.exec(`chmod 600 ${shellArg(remotePath)}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function expectedRouteAuthRedirectUris(routeLabels: string[]): string[] {
  const profiles = new Set<string>();
  const redirectUris: string[] = [];
  for (const label of routeLabels) {
    const authIndex = label.lastIndexOf("@auth");
    if (authIndex === -1) {
      continue;
    }

    const route = label.slice(0, authIndex);
    const suffix = label.slice(authIndex);
    if (!/^@auth(?::[A-Za-z0-9._,-]+)?$/.test(suffix)) {
      throw new Error(`unsupported auth suffix: ${suffix}`);
    }

    const parsed = new URL(route);
    const groups = [
      ...new Set(
        suffix.includes(":")
          ? suffix
              .slice(suffix.indexOf(":") + 1)
              .split(",")
              .map((group) => group.trim())
              .filter(Boolean)
          : []
      )
    ].sort();
    const key = `${parsed.hostname}\n${groups.join("\n")}`;
    if (profiles.has(key)) {
      continue;
    }
    profiles.add(key);

    const policy = groups.length > 0 ? groups.join("-") : "authenticated";
    const base = slugify(`${parsed.hostname}-${policy}`);
    const trimmed = base.length > 56 ? base.slice(0, 56).replace(/-+$/g, "") : base;
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 10);
    redirectUris.push(`https://${parsed.hostname}/oauth2/route/${trimmed || "route"}-${hash}/callback`);
  }
  return redirectUris.sort();
}

/** Creates a Hetzner host and optionally attaches a raw block volume for Terrarium. */
export async function provisionHost(context: IntegrationContext, options: HostProvisionOptions, sshKeyId: number): Promise<ManagedHost> {
  const labels = { terrarium: "integration", run: context.config.slug, role: options.label };
  const server = await context.createHetznerServer(
    options.label,
    `terrarium-${context.config.slug}-${options.label}`,
    context.config.hcloudServerType,
    context.config.hcloudLocation,
    [sshKeyId],
    labels
  );

  let volume: VolumeRecord | undefined;
  if (options.withVolume) {
    volume = await context.createHetznerVolume(
      options.label,
      `terrarium-${context.config.slug}-${options.label}`,
      context.config.hcloudVolumeSizeGb,
      context.config.hcloudLocation,
      labels
    );
    volume = await context.attachHetznerVolume(options.label, volume.id, server.id);
  }

  const host = context.host(options.label, server, context.domainBundle(options.label, server.ipv4), volume);
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
  const secretFiles: string[] = [];
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
    `--domain ${shellArg(context.publicDns.rootDomain(host.server.ipv4))}`,
    `--email ${shellArg(options.email || baseEmail(context))}`,
    `--acme-email ${shellArg(options.acmeEmail || baseEmail(context))}`,
    `--idp ${options.idpMode}`,
    `--storage-mode ${options.storageMode}`
  ];
  const rootPasswordPath = `/root/terrarium-install-${host.label}-root-password`;
  await uploadSecretFile(ssh, rootPasswordPath, `Terrarium!${context.config.slug}`);
  secretFiles.push(rootPasswordPath);
  args.push(`--root-pwd-file ${shellArg(rootPasswordPath)}`);

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
    const oidcSecretPath = `/root/terrarium-install-${host.label}-oidc-secret`;
    await uploadSecretFile(ssh, oidcSecretPath, options.oidcClientSecret || "");
    secretFiles.push(oidcSecretPath);
    args.push(`--oidc-secret-file ${shellArg(oidcSecretPath)}`);
    if (options.lxdOidcClientId) {
      args.push(`--lxd-oidc-client ${shellArg(options.lxdOidcClientId)}`);
      if (options.lxdOidcClientSecret) {
        const lxdOidcSecretPath = `/root/terrarium-install-${host.label}-lxd-oidc-secret`;
        await uploadSecretFile(ssh, lxdOidcSecretPath, options.lxdOidcClientSecret);
        secretFiles.push(lxdOidcSecretPath);
        args.push(`--lxd-oidc-secret-file ${shellArg(lxdOidcSecretPath)}`);
      }
    }
  }
  if (options.enableS3) {
    args.push("--enable-s3");
    args.push(`--s3-endpoint ${shellArg(context.config.s3Endpoint)}`);
    args.push(`--s3-bucket ${shellArg(context.config.s3Bucket)}`);
    args.push(`--s3-region ${shellArg(context.config.s3Region)}`);
    args.push(`--s3-prefix ${shellArg(`terrarium/${context.config.slug}/${host.label}`)}`);
    args.push(`--s3-access-key ${shellArg(context.config.s3AccessKey)}`);
    const s3SecretPath = `/root/terrarium-install-${host.label}-s3-secret-key`;
    await uploadSecretFile(ssh, s3SecretPath, context.config.s3SecretKey);
    secretFiles.push(s3SecretPath);
    args.push(`--s3-secret-key-file ${shellArg(s3SecretPath)}`);
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
    ...(secretFiles.length > 0 ? [`trap "rm -f ${secretFiles.map(shellArg).join(" ")}" EXIT`] : []),
    `export TERRARIUM_REPO_URL=${shellArg("file:///root/terrarium-src")}`,
    `export TERRARIUM_BUNDLE_DIR=${shellArg("/root/terrarium-bundle")}`,
    args.join(" ")
  ].join(" && ");
  await ssh.execDetached(installCommand, remoteScriptPath, remoteStatusPath, remoteLogPath);
  await waitForDetachedCommand(ssh, remoteStatusPath, remoteLogPath, 45 * 60 * 1000);
  await ssh.exec("test -L /usr/local/bin/trm && /usr/local/bin/trm status >/dev/null");
}

/** Returns the local ZITADEL bootstrap credentials from an installed Terrarium host. */
export async function readLocalZitadelAdmin(host: SshHost): Promise<{ email: string; password: string }> {
  const config = await host.read("/etc/terrarium/config.yaml");
  const emailMatch = config.match(/terrarium_zitadel_admin_email:\s*(.+)/);
  const instanceMatch = config.match(/terrarium_zitadel_instance_name:\s*(.+)/);
  const instance = (instanceMatch?.[1] || "terrarium-idp").trim().replace(/^["']|["']$/g, "");
  const passwordResult = await host.execAllowFailure(
    `if lxc info ${shellArg(instance)} >/dev/null 2>&1; then lxc exec ${shellArg(
      instance
    )} -- cat /etc/terrarium/secrets/zitadel_admin_password; else cat /etc/terrarium/secrets/zitadel_admin_password; fi`
  );
  const password = passwordResult.stdout.trim();
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
  await waitForHttpStatusResolved(`https://${host.domains.manage}`, [302, 303], { timeoutMs: 300000, resolveIp: host.server.ipv4 });
  await waitForHttpStatusResolved(`https://${host.domains.proxy}`, [302, 303], { timeoutMs: 300000, resolveIp: host.server.ipv4 });
  await waitForHttpStatusResolved(`https://${host.domains.lxd}`, [200, 302], { timeoutMs: 300000, resolveIp: host.server.ipv4 });
  if (includeAuth) {
    await waitForHttpStatusResolved(`https://${host.domains.auth}/.well-known/openid-configuration`, [200], {
      timeoutMs: 300000,
      resolveIp: host.server.ipv4
    });
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
  context.logger.info(`verify ${host.label} management UI as ${user.email}`);
  await expectManagementUi(`https://${host.domains.manage}`, `https://${host.domains.proxy}`, user as never, outputDir, {
    resolveIp: host.server.ipv4,
    resolveHosts: {
      [host.domains.auth]: host.server.ipv4
    }
  });
  context.logger.info(`verified ${host.label} management UI`);
}

/** Verifies the browser-facing management surfaces without relaunching Chromium between apps. */
export async function verifyManagementSurfaces(
  context: IntegrationContext,
  host: ManagedHost,
  user: { email: string; password: string; userId?: string; roles?: string[] }
): Promise<void> {
  const outputDir = join(context.localArtifactsDir, host.label, "browser");
  mkdirSync(outputDir, { recursive: true });
  context.logger.info(`verify ${host.label} management surfaces as ${user.email}`);
  await expectManagementSurfaces(
    `https://${host.domains.manage}`,
    `https://${host.domains.proxy}`,
    `https://${host.domains.lxd}`,
    user as never,
    outputDir,
    {
      resolveIp: host.server.ipv4,
      resolveHosts: {
        [host.domains.auth]: host.server.ipv4
      }
    }
  );
  context.logger.info(`verified ${host.label} management surfaces`);
}

/** Verifies the public LXD endpoint serves the real API over trusted TLS and does not expose trusted anonymous access. */
export async function verifyLxdApi(host: ManagedHost): Promise<void> {
  await expectHttpsJson(
    `https://${host.domains.lxd}/1.0`,
    (body) => {
      if (!isObject(body)) {
        throw new Error("LXD API root did not return an object");
      }

      const metadata = body.metadata;
      if (!isObject(metadata)) {
        throw new Error("LXD API root did not include metadata");
      }

      if (!Array.isArray(metadata.api_extensions)) {
        throw new Error("LXD API root did not include api_extensions");
      }

      const auth = typeof metadata.auth === "string" ? metadata.auth.toLowerCase() : "";
      if (!auth) {
        throw new Error("LXD API root did not include auth state");
      }
      if (auth === "trusted") {
        throw new Error("LXD API root allowed trusted anonymous access");
      }
    },
    { timeoutMs: 300000, resolveIp: host.server.ipv4 }
  );
}

/** Verifies a real browser login through LXD's public OIDC flow. */
export async function verifyLxdUi(
  context: IntegrationContext,
  host: ManagedHost,
  user: { email: string; password: string; userId?: string; roles?: string[] }
): Promise<void> {
  const outputDir = join(context.localArtifactsDir, host.label, "lxd-browser");
  mkdirSync(outputDir, { recursive: true });
  context.logger.info(`verify ${host.label} LXD UI as ${user.email}`);
  await expectLxdUi(`https://${host.domains.lxd}`, user as never, outputDir, {
    resolveIp: host.server.ipv4,
    resolveHosts: {
      [host.domains.auth]: host.server.ipv4
    }
  });
  context.logger.info(`verified ${host.label} LXD UI`);
}

/** Creates a small HTTP server inside an LXC and publishes the requested proxy labels. */
export async function createHttpFixtureContainer(
  host: SshHost,
  containerName: string,
  labels: string[],
  bodyText: string
): Promise<void> {
  const setupLogPath = `/root/${containerName}-setup.log`;
  const setupScriptPath = `/root/${containerName}-setup.sh`;
  const setupRunnerPath = `/root/${containerName}-setup-runner.sh`;
  const setupStatusPath = `/root/${containerName}-setup.exit`;
  const setupCommand = [
    `echo '[fixture] launch ${containerName}'`,
    `timeout 300s lxc launch ubuntu:24.04 ${shellArg(containerName)}`,
    `echo '[fixture] wait-running ${containerName}'`,
    `timeout 300s bash -lc ${shellArg(
      `until lxc info ${shellArg(containerName)} | grep -F 'Status: RUNNING' >/dev/null 2>&1; do sleep 2; done`
    )}`,
    `echo '[fixture] wait-ipv4 ${containerName}'`,
    `timeout 300s bash -lc ${shellArg(
      `until lxc query /1.0/instances/${containerName}/state | jq -e '(.network // {} | to_entries | any((.value.addresses // []) | any(.family == "inet" and .scope == "global" and (.address | length > 0))))' >/dev/null 2>&1; do sleep 2; done`
    )}`,
    `echo '[fixture] install-httpd ${containerName}'`,
    `timeout 600s lxc exec ${shellArg(containerName)} -- bash -lc ${shellArg(
      `export DEBIAN_FRONTEND=noninteractive && apt-get update && apt-get install -y python3 && mkdir -p /srv/www && printf '%s\\n' ${shellArg(
        bodyText
      )} > /srv/www/index.html && cat >/etc/systemd/system/terrarium-fixture-http.service <<'EOF'
[Unit]
Description=Terrarium integration HTTP fixture
After=network-online.target

[Service]
WorkingDirectory=/srv/www
ExecStart=/usr/bin/python3 -m http.server 8080 --directory /srv/www
Restart=always

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now terrarium-fixture-http.service`
    )}`,
    `echo '[fixture] set-proxy-labels ${containerName}'`,
    `lxc config set ${shellArg(containerName)} user.proxy ${shellArg(labels.join(","))}`,
    `echo '[fixture] proxy-sync ${containerName}'`,
    `timeout 300s ${remoteCtl("proxy sync")}`,
    `echo '[fixture] done ${containerName}'`
  ].join(" && ");

  await deleteContainerIfPresent(host, containerName);
  await host.exec(`rm -f ${shellArg(setupLogPath)} ${shellArg(setupScriptPath)} ${shellArg(setupRunnerPath)} ${shellArg(setupStatusPath)}`);
  await host.write(
    setupScriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
${setupCommand}
`,
    "700"
  );
  await host.execDetached(shellArg(setupScriptPath), setupRunnerPath, setupStatusPath, setupLogPath);
  await waitForDetachedCommand(host, setupStatusPath, setupLogPath, 20 * 60 * 1000);
}

/** Forces local snapshots, mutates container state, and verifies in-place restore. */
export async function verifyLocalBackupRestore(host: SshHost, containerName: string): Promise<void> {
  const dataset = `terrarium/containers/${containerName}`;
  const snapshotName = `smoke-local-restore-${Date.now()}`;
  await host.exec(`lxc exec ${shellArg(containerName)} -- bash -lc "echo v1 > /srv/www/state.txt"`);
  await host.exec(`zfs snapshot -r ${shellArg(`${dataset}@${snapshotName}`)}`);
  await host.exec(`lxc exec ${shellArg(containerName)} -- bash -lc "echo v2 > /srv/www/state.txt"`);
  await host.exec(`printf 'y\\n' | ${remoteCtl(`backup restore --instance ${shellArg(containerName)} --at ${shellArg(snapshotName)}`)}`);
  await host.exec(`lxc start ${shellArg(containerName)} || true`);
  await expectRemoteContains(host, `lxc exec ${shellArg(containerName)} -- cat /srv/www/state.txt`, "v1");
}

/** Verifies the S3 export and restore path against the configured real bucket. */
export async function verifyS3BackupRestore(host: SshHost, containerName: string): Promise<void> {
  await host.exec(remoteCtl("backup export"));
  await host.exec(`lxc exec ${shellArg(containerName)} -- bash -lc "echo v3 > /srv/www/state.txt"`);
  await host.exec(`printf 'y\\n' | ${remoteCtl(`backup restore --source s3 --instance ${shellArg(containerName)}`)}`);
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
  const scriptPath = `/root/terrarium-switch-oidc-${randomUUID()}.sh`;
  const secretPath = `/root/terrarium-switch-oidc-${randomUUID()}-secret`;
  await uploadSecretFile(ssh, secretPath, fixture.clientSecret);
  await ssh.execScript(
    `#!/usr/bin/env bash
set -euo pipefail
trap "rm -f ${shellArg(secretPath)}" EXIT
${remoteCtl("set idp oidc")} \\
  --oidc ${shellArg(context.config.zitadelCloudIssuer)} \\
  --oidc-client ${shellArg(fixture.clientId)} \\
  --oidc-secret-file ${shellArg(secretPath)} \\
  --lxd-oidc-client ${shellArg(fixture.lxdClientId)} \\
  --admin-group ${shellArg(fixture.adminGroup)}
`,
    scriptPath
  );
  await verifyManagementSurfaces(context, host, fixture.adminUser);
  await verifyLxdApi(host);
}

/** Reconfigures the primary host back to local ZITADEL and validates its management UIs. */
export async function switchBackToLocalIdp(context: IntegrationContext, host: ManagedHost): Promise<void> {
  const ssh = context.ssh(host);
  const scriptPath = `/root/terrarium-switch-local-idp-${randomUUID()}.sh`;
  await ssh.execScript(
    `#!/usr/bin/env bash
set -euo pipefail
${remoteCtl("set idp local")}
`,
    scriptPath
  );
  const admin = await readLocalZitadelAdmin(ssh);
  await verifyManagementSurfaces(context, host, admin);
  await verifyLxdApi(host);
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
  const readiness = { timeoutMs: 300000, resolveIp: host.server.ipv4 };
  context.logger.info(`verify ${host.label} route matrix readiness`);
  await withStepTimeout(`plain route readiness for ${plainHost}`, 6 * 60 * 1000, () => waitForHttpStatusResolved(`https://${plainHost}`, [200, 302], readiness));
  await withStepTimeout(`auth route readiness for ${authHost}`, 6 * 60 * 1000, () => waitForHttpStatusResolved(`https://${authHost}`, [302, 303], readiness));
  await withStepTimeout(`group route readiness for ${groupedHost}`, 6 * 60 * 1000, () =>
    waitForHttpStatusResolved(`https://${groupedHost}`, [302, 303], readiness)
  );

  const outputDir = join(context.localArtifactsDir, host.label, "routes");
  mkdirSync(outputDir, { recursive: true });
  context.logger.info(`verify ${host.label} plain route body`);
  await withStepTimeout(`plain route body for ${plainHost}`, 6 * 60 * 1000, () => expectHttpBodyContains(`https://${plainHost}`, bodyText, readiness));
  context.logger.info(`verify ${host.label} auth route allows ${fixture.routeUser.email}`);
  await expectProtectedRoute(`https://${authHost}`, fixture.routeUser, "allow", outputDir, bodyText, { resolveIp: host.server.ipv4 });
  context.logger.info(`verify ${host.label} grouped route allows ${fixture.routeUser.email}`);
  await expectProtectedRoute(`https://${groupedHost}`, fixture.routeUser, "allow", outputDir, bodyText, { resolveIp: host.server.ipv4 });
  context.logger.info(`verify ${host.label} grouped route denies ${fixture.deniedUser.email}`);
  await expectProtectedRoute(`https://${groupedHost}`, fixture.deniedUser, "deny", outputDir, "", { resolveIp: host.server.ipv4 });
  context.logger.info(`verified ${host.label} route matrix`);
}

/** Applies a handful of `terrariumctl set ...` operations and validates convergence. */
export async function exerciseReconfiguration(context: IntegrationContext, host: ManagedHost): Promise<void> {
  const ssh = context.ssh(host);
  const rootDomain = context.publicDns.rootDomain(host.server.ipv4);
  const altManage = context.publicDns.serviceHost("manage-alt", context.config.slug, host.server.ipv4);
  const altProxy = context.publicDns.serviceHost("proxy-alt", context.config.slug, host.server.ipv4);
  const altLxd = context.publicDns.serviceHost("lxd-alt", context.config.slug, host.server.ipv4);
  const altAuth = context.publicDns.serviceHost("auth-alt", context.config.slug, host.server.ipv4);
  await ssh.exec(
    `printf 'y\\n' | ${remoteCtl(`set domains ${shellArg(rootDomain)}`)} --manage-domain ${shellArg(altManage)} --proxy-domain ${shellArg(
      altProxy
    )} --lxd-domain ${shellArg(altLxd)} --auth-domain ${shellArg(altAuth)}`
  );
  await ssh.exec(`${remoteCtl("set emails")} --email ${shellArg(baseEmail(context))} --acme-email ${shellArg(baseEmail(context))}`);
  const s3SecretPath = "/root/terrarium-reconfigure-s3-secret";
  await uploadSecretFile(ssh, s3SecretPath, context.config.s3SecretKey);
  await ssh.exec(
    `trap "rm -f ${shellArg(s3SecretPath)}" EXIT && ${remoteCtl("set s3")} --enable --s3-endpoint ${shellArg(context.config.s3Endpoint)} --s3-bucket ${shellArg(
      context.config.s3Bucket
    )} --s3-region ${shellArg(context.config.s3Region)} --s3-prefix ${shellArg(`terrarium/${context.config.slug}/reconfigured`)} --s3-access-key ${shellArg(
      context.config.s3AccessKey
    )} --s3-secret-key-file ${shellArg(s3SecretPath)}`
  );
  await ssh.exec(remoteCtl("set syncoid --disable"));
  await ssh.exec(`${remoteCtl("set syncoid --enable")} --syncoid-target root@127.0.0.1 --syncoid-target-dataset terrarium/containers --syncoid-ssh-key /root/.ssh/id_ed25519`).catch(() => {
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
  await expectRemoteContains(host, remoteCtl("status"), "terrarium-oauth2-proxy.service");
  await expectSystemdActive(host, "traefik");
  await expectSystemdActive(host, "terrarium-traefik-sync.timer");
  await expectRemoteContains(host, "lxc network show terrarium-ovn", "type: ovn");
  await expectRemoteContains(host, "lxc profile show default", "network: terrarium-ovn");
}

/** Creates a partitioned disk layout with a large free extent for partition-mode install tests. */
export async function preparePartitionTarget(host: SshHost, devicePath: string): Promise<void> {
  await host.exec(`parted -s ${shellArg(devicePath)} mklabel gpt`);
  await host.exec(`parted -s ${shellArg(devicePath)} unit MiB mkpart primary ext4 1 2048`);
}

/** Uploads the runner SSH key onto the primary host so syncoid can reach the replica. */
export async function installSyncoidKey(
  primary: SshHost,
  privateKeyPath: string,
  publicKeyPath: string,
  replicaHost: string
): Promise<void> {
  await primary.exec("mkdir -p /root/.ssh");
  await primary.uploadKeypair(privateKeyPath, publicKeyPath, "/root/.ssh/id_ed25519");
  await primary.exec("touch /root/.ssh/known_hosts && chmod 600 /root/.ssh/known_hosts");
  await primary.exec(
    `ssh-keygen -R ${shellArg(replicaHost)} -f /root/.ssh/known_hosts >/dev/null 2>&1 || true && ssh-keyscan -H ${shellArg(
      replicaHost
    )} >> /root/.ssh/known_hosts`
  );
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "route";
}

async function waitForDetachedCommand(host: SshHost, statusPath: string, logPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await host.execAllowFailure(`test -f ${shellArg(statusPath)} && cat ${shellArg(statusPath)}`, { timeoutMs: 20000 });
    if (result.exitCode === 0) {
      const exitCode = Number(result.stdout.trim() || "1");
      if (exitCode !== 0) {
        const log = await host.execAllowFailure(`tail -n 200 ${shellArg(logPath)} || true`, { timeoutMs: 20000 });
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

  const tail = await host.execAllowFailure(`tail -n 200 ${shellArg(logPath)} || true`, { timeoutMs: 20000 });
  throw new Error(`timed out waiting for remote command to finish\n${tail.stdout || tail.stderr}`);
}

async function withStepTimeout<T>(label: string, timeoutMs: number, task: () => Promise<T>): Promise<T> {
  let timer: Timer | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function waitForRemoteCommandSuccess(
  host: SshHost,
  command: string,
  description: string,
  timeoutMs: number,
  attemptTimeoutMs = 30000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await host.execAllowFailure(command, { timeoutMs: attemptTimeoutMs });
    if (result.exitCode === 0) {
      return;
    }
    await Bun.sleep(5000);
  }

  throw new Error(`timed out waiting for ${description}`);
}

async function deleteContainerIfPresent(host: SshHost, containerName: string): Promise<void> {
  const exists = await host.execAllowFailure(`timeout 30s lxc info ${shellArg(containerName)} >/dev/null 2>&1`, { timeoutMs: 60000 });
  if (exists.exitCode !== 0) {
    return;
  }

  const deletion = await host.execAllowFailure(`timeout 120s lxc delete ${shellArg(containerName)} --force`, { timeoutMs: 180000 });
  if (deletion.exitCode !== 0 && deletion.exitCode !== 124) {
    throw new Error(deletion.stderr.trim() || deletion.stdout.trim() || `failed to delete existing container ${containerName}`);
  }

  await waitForRemoteCommandSuccess(
    host,
    `! lxc info ${shellArg(containerName)} >/dev/null 2>&1`,
    `container ${containerName} to be deleted`,
    2 * 60 * 1000
  );
}
