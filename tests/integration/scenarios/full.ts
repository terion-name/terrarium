import { IntegrationContext } from "../context";
import { expectRemoteContains } from "../assertions/host";
import {
  captureFailureArtifacts,
  createHttpFixtureContainer,
  expectedRouteAuthRedirectUris,
  installTerrarium,
  preparePartitionTarget,
  provisionHost,
  uploadSecretFile
} from "./common";
import { runSmokeSuite } from "./smoke";

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function joinRemotePath(...segments: string[]): string {
  const joined = segments
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return `/${joined}`;
}

async function verifySharedCifsStorage(context: IntegrationContext, fileSsh: ReturnType<IntegrationContext["ssh"]>): Promise<void> {
  const sharedHostPath = `/srv/shared/${context.config.slug}`;
  const sharedRelativePath = context.cifs.runPath(context.config.slug);
  const sharedRunPath = sharedRelativePath ? joinRemotePath(sharedHostPath, sharedRelativePath) : sharedHostPath;
  const sharedNoteName = `terrarium-${context.config.slug}-note.txt`;
  const sharedContainer = `shared-${context.config.slug}`;
  const cifsSecretPath = "/root/terrarium-full-cifs-secret";

  await uploadSecretFile(fileSsh, cifsSecretPath, context.config.cifsPassword);
  try {
    await fileSsh.exec(
      `trap "rm -f ${shellArg(cifsSecretPath)}" EXIT && terrariumctl mount add cifs ${shellArg(sharedHostPath)} ${shellArg(context.config.cifsAddress)} ${shellArg(
        context.config.cifsUsername
      )} --password-file ${shellArg(cifsSecretPath)}`
    );
    await fileSsh.exec("terrariumctl mount list");
    if (sharedRelativePath) {
      await fileSsh.exec(`mkdir -p ${shellArg(sharedRunPath)}`);
    }

    const writeResult = await fileSsh.execAllowFailure(`echo shared > ${shellArg(`${sharedRunPath}/${sharedNoteName}`)}`);
    if (writeResult.exitCode !== 0) {
      const reason = writeResult.stderr.trim() || writeResult.stdout.trim() || `exit ${writeResult.exitCode}`;
      throw new Error(
        `configured CIFS fixture is not writable at ${sharedRunPath}: ${reason}. Set CIFS_ADDRESS/CIFS_HOST_PATH_BASE to a writable SMB path or fix the SMB account permissions.`
      );
    }

    await fileSsh.exec(`lxc launch ubuntu:24.04 ${sharedContainer} --profile terrarium`);
    await fileSsh.exec(`lxc config device add ${sharedContainer} shared disk source=${shellArg(sharedRunPath)} path=/mnt/shared`);
    await fileSsh.exec(`lxc exec ${sharedContainer} -- cat ${shellArg(`/mnt/shared/${sharedNoteName}`)}`);
  } finally {
    await fileSsh.execAllowFailure(`lxc delete ${sharedContainer} --force`);
    await fileSsh.execAllowFailure(`printf 'y\\n' | terrariumctl mount remove ${shellArg(sharedHostPath)}`);
    await fileSsh.execAllowFailure(`rm -f ${shellArg(cifsSecretPath)}`);
  }
}

async function restoreAsNewAndWait(
  host: ReturnType<IntegrationContext["ssh"]>,
  sourceInstance: string,
  restoredInstance: string,
  snapshotName: string
): Promise<void> {
  const expectScript = `
set timeout 180
spawn terrariumctl backup restore --instance ${sourceInstance} --at ${snapshotName} --as-new ${restoredInstance}
expect {
  -re {Would you like to continue with scanning[^\\r\\n]*} {
    send "yes\\r"
    exp_continue
  }
  -re {Would you like those to be recovered[^\\r\\n]*} {
    send "yes\\r"
    exp_continue
  }
  -re {Would you like.*recover[^\\r\\n]*} {
    send "yes\\r"
    exp_continue
  }
  -re {Please create those missing entries and then hit ENTER[^\\r\\n]*} {
    puts stderr "lxd recover requires missing LXD entities before import can continue"
    exit 2
  }
  timeout {
    puts stderr "timed out driving restore-as-new recovery"
    exit 124
  }
  eof {}
}
set waitResult [wait]
exit [lindex $waitResult 3]
`.trim();

  await host.exec(`expect -c ${shellArg(expectScript)}`);
  await host.exec(`timeout 60s bash -lc ${shellArg(`until lxc info ${restoredInstance} >/dev/null 2>&1; do sleep 2; done`)}`);
}

async function startLxdInstanceAndWait(host: ReturnType<IntegrationContext["ssh"]>, instance: string): Promise<void> {
  const script = `
set -euo pipefail
status="$(lxc info ${shellArg(instance)} | awk -F': ' '/^Status:/ {print $2; exit}')"
if [ "$status" != "RUNNING" ]; then
  lxc start ${shellArg(instance)}
fi
timeout 60s bash -lc ${shellArg(
    `until [ "$(lxc info ${shellArg(instance)} | awk -F': ' '/^Status:/ {print $2; exit}')" = RUNNING ]; do sleep 2; done`
  )}
`.trim();
  await host.exec(`bash -lc ${shellArg(script)}`);
}

/** Runs the exhaustive manual/release-preflight suite on top of the smoke baseline. */
export async function runFullSuite(context: IntegrationContext): Promise<void> {
  await runSmokeSuite(context);

  const sshKeyId = await context.registerHetznerKey(`terrarium-full-${context.config.slug}`);
  const fileHost = await provisionHost(context, { label: "full-file", withVolume: false }, sshKeyId);
  const partitionHost = await provisionHost(context, { label: "full-partition", withVolume: true }, sshKeyId);
  const fileSsh = context.ssh(fileHost);
  const partitionSsh = context.ssh(partitionHost);
  const rootDomain = context.publicDns.rootDomain(fileHost.server.ipv4);

  try {
    const composeRouteLabels = [`https://compose-${context.config.slug}.${rootDomain}@auth:agents,admins`];
    const routeCallbackUris = expectedRouteAuthRedirectUris(composeRouteLabels);
    const externalFixture = await context.provisionZitadelFixture(
      `${context.config.slug}-full`,
      fileHost.domains,
      "terrarium-admins",
      routeCallbackUris
    );

    await context.publicDns.waitForHosts(
      [fileHost.domains.manage, fileHost.domains.proxy, fileHost.domains.lxd, fileHost.domains.auth],
      fileHost.server.ipv4
    );

    await installTerrarium(context, fileHost, {
      idpMode: "oidc",
      storageMode: "file",
      storageSize: "32G",
      oidcIssuer: context.config.zitadelCloudIssuer,
      oidcClientId: externalFixture.clientId,
      oidcClientSecret: externalFixture.clientSecret,
      lxdOidcClientId: externalFixture.lxdClientId,
      lxdOidcClientSecret: externalFixture.lxdClientSecret,
      adminGroup: externalFixture.adminGroup
    });

    await verifySharedCifsStorage(context, fileSsh);

    await context.publicDns.waitForHosts(
      [partitionHost.domains.manage, partitionHost.domains.proxy, partitionHost.domains.lxd, partitionHost.domains.auth],
      partitionHost.server.ipv4
    );

    await preparePartitionTarget(partitionSsh, partitionHost.volume?.linuxDevice || "/dev/sdb");
    await installTerrarium(context, partitionHost, {
      idpMode: "local",
      storageMode: "partition",
      storageSource: "auto",
      storageSize: "32G"
    });

    await context.publicDns.waitForHosts(
      [fileHost.domains.manage, fileHost.domains.proxy, fileHost.domains.lxd, fileHost.domains.auth],
      fileHost.server.ipv4
    );

    await createHttpFixtureContainer(
      fileSsh,
      `compose-${context.config.slug}`,
      composeRouteLabels,
      "compose-ok"
    );

    const composeInstance = `compose-${context.config.slug}`;
    const restoredComposeInstance = `${composeInstance}-restored`;
    const restoreSnapshotName = `full-as-new-${Date.now()}`;
    await fileSsh.exec(`zfs snapshot -r ${shellArg(`terrarium/containers/${composeInstance}@${restoreSnapshotName}`)}`);
    await fileSsh.exec("apt-get update && apt-get install -y expect");
    await restoreAsNewAndWait(fileSsh, composeInstance, restoredComposeInstance, restoreSnapshotName);
    await startLxdInstanceAndWait(fileSsh, restoredComposeInstance);
    await expectRemoteContains(fileSsh, `lxc exec ${shellArg(restoredComposeInstance)} -- cat /srv/www/index.html`, "compose-ok");

    const s3SecretPath = "/root/terrarium-full-s3-secret";
    await uploadSecretFile(fileSsh, s3SecretPath, context.config.s3SecretKey);
    await fileSsh.exec(
      `trap "rm -f ${shellArg(s3SecretPath)}" EXIT && terrariumctl set s3 --enable --s3-endpoint ${shellArg(context.config.s3Endpoint)} --s3-bucket ${shellArg(
        context.config.s3Bucket
      )} --s3-region ${shellArg(context.config.s3Region)} --s3-prefix ${shellArg(
        `terrarium/${context.config.slug}/full`
      )} --s3-access-key ${shellArg(context.config.s3AccessKey)} --s3-secret-key-file ${shellArg(s3SecretPath)}`
    );
    const badS3 = await fileSsh.execAllowFailure(
      `terrariumctl set s3 --enable --s3-endpoint ${shellArg(context.config.s3Endpoint)} --s3-bucket ${shellArg(
        context.config.s3Bucket
      )} --s3-region ${shellArg(context.config.s3Region)} --s3-prefix ${shellArg(`terrarium/${context.config.slug}/full`)} --s3-access-key bad --s3-secret-key bad`
    );
    if (badS3.exitCode === 0) {
      throw new Error("expected bad S3 credentials to fail");
    }
    const badOidc = await fileSsh.execAllowFailure(
      `terrariumctl set idp oidc --oidc ${shellArg(context.config.zitadelCloudIssuer)} --oidc-client bad --oidc-secret bad --admin-group terrarium-admins`
    );
    if (badOidc.exitCode === 0) {
      throw new Error("expected bad OIDC credentials to fail");
    }
  } catch (error) {
    await captureFailureArtifacts(context, [fileHost, partitionHost]);
    throw error;
  }
}
