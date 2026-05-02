import { IntegrationContext } from "../context";
import { expectRemoteContains } from "../assertions/host";
import {
  assertInstalledHost,
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

function lastNonEmptyLine(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

function joinRemotePath(...segments: string[]): string {
  const joined = segments
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return `/${joined}`;
}

async function waitForClusterMembers(host: ReturnType<IntegrationContext["ssh"]>, members: string[]): Promise<void> {
  const script = `
set -euo pipefail
timeout 300s bash -lc ${shellArg(
    `until lxc cluster list --format json | jq -r '.[].server_name' | grep -Fx ${shellArg(members[0])} >/dev/null; do sleep 2; done`
  )}
${members
  .slice(1)
  .map(
    (member) =>
      `timeout 300s bash -lc ${shellArg(`until lxc cluster list --format json | jq -r '.[].server_name' | grep -Fx ${shellArg(member)} >/dev/null; do sleep 2; done`)}`
  )
  .join("\n")}
`.trim();
  await host.exec(`bash -lc ${shellArg(script)}`);
}

async function verifyClusterOvnWorkloads(
  host: ReturnType<IntegrationContext["ssh"]>,
  firstMember: string,
  secondMember: string,
  slug: string
): Promise<void> {
  const firstInstance = `cluster-a-${slug}`;
  const secondInstance = `cluster-b-${slug}`;
  const script = `
set -euo pipefail

wait_running() {
  local instance="$1"
  local deadline=$((SECONDS + 300))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if lxc info "$instance" | grep -F 'Status: RUNNING' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

instance_ip() {
  local instance="$1"
  local deadline=$((SECONDS + 300))
  local ip=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    ip="$(lxc query "/1.0/instances/$instance/state" | jq -er '(.network // {} | to_entries[] | .value.addresses[]? | select(.family == "inet" and .scope == "global") | .address)' | head -n1 || true)"
    if [ -n "$ip" ]; then
      printf '%s\\n' "$ip"
      return 0
    fi
    sleep 2
  done
  return 1
}

lxc delete ${shellArg(firstInstance)} --force >/dev/null 2>&1 || true
lxc delete ${shellArg(secondInstance)} --force >/dev/null 2>&1 || true

lxc launch ubuntu:24.04 ${shellArg(firstInstance)} --target ${shellArg(firstMember)}
lxc launch ubuntu:24.04 ${shellArg(secondInstance)} --target ${shellArg(secondMember)}
wait_running ${shellArg(firstInstance)}
wait_running ${shellArg(secondInstance)}

first_ip="$(instance_ip ${shellArg(firstInstance)})"
second_ip="$(instance_ip ${shellArg(secondInstance)})"
test -n "$first_ip"
test -n "$second_ip"

lxc exec ${shellArg(firstInstance)} -- ping -c 3 -W 5 "$second_ip"
lxc exec ${shellArg(secondInstance)} -- ping -c 3 -W 5 "$first_ip"
lxc list
`.trim();

  try {
    await host.exec(`bash -lc ${shellArg(script)}`, { timeoutMs: 15 * 60 * 1000 });
  } finally {
    await host.execAllowFailure(`lxc delete ${shellArg(firstInstance)} --force`, { timeoutMs: 120000 });
    await host.execAllowFailure(`lxc delete ${shellArg(secondInstance)} --force`, { timeoutMs: 120000 });
  }
}

async function verifyClusterRemoveWithMove(
  host: ReturnType<IntegrationContext["ssh"]>,
  remainingMember: string,
  removedMember: string,
  slug: string
): Promise<void> {
  const instance = `cluster-remove-${slug}`;
  const script = `
set -euo pipefail

wait_running() {
  local instance="$1"
  local deadline=$((SECONDS + 300))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if lxc info "$instance" | grep -F 'Status: RUNNING' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

lxc delete ${shellArg(instance)} --force >/dev/null 2>&1 || true
lxc launch ubuntu:24.04 ${shellArg(instance)} --target ${shellArg(removedMember)}
wait_running ${shellArg(instance)}

terrariumctl cluster remove ${shellArg(removedMember)} --move --yes
timeout 300s bash -lc ${shellArg(`until ! lxc cluster list --format json | jq -r '.[].server_name' | grep -Fx ${shellArg(removedMember)} >/dev/null; do sleep 2; done`)}
test "$(lxc query ${shellArg(`/1.0/instances/${instance}`)} | jq -r '.location')" = ${shellArg(remainingMember)}
wait_running ${shellArg(instance)}
`.trim();

  try {
    await host.exec(`bash -lc ${shellArg(script)}`, { timeoutMs: 20 * 60 * 1000 });
  } finally {
    await host.execAllowFailure(`lxc delete ${shellArg(instance)} --force`, { timeoutMs: 120000 });
  }
}

async function verifyClusterWorkloadOperations(
  host: ReturnType<IntegrationContext["ssh"]>,
  firstMember: string,
  secondMember: string,
  slug: string
): Promise<void> {
  const moveInstance = `cluster-move-${slug}`;
  const evacuateInstance = `cluster-evacuate-${slug}`;
  const restoreProbeInstance = `cluster-restore-${slug}`;
  const script = `
set -euo pipefail

wait_running() {
  local instance="$1"
  local deadline=$((SECONDS + 300))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if lxc info "$instance" | grep -F 'Status: RUNNING' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

wait_location() {
  local instance="$1"
  local member="$2"
  local deadline=$((SECONDS + 300))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(lxc query "/1.0/instances/$instance" | jq -r '.location')" = "$member" ]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

lxc delete ${shellArg(moveInstance)} --force >/dev/null 2>&1 || true
lxc delete ${shellArg(evacuateInstance)} --force >/dev/null 2>&1 || true
lxc delete ${shellArg(restoreProbeInstance)} --force >/dev/null 2>&1 || true

lxc launch ubuntu:24.04 ${shellArg(moveInstance)} --target ${shellArg(firstMember)}
wait_running ${shellArg(moveInstance)}
terrariumctl cluster move ${shellArg(moveInstance)} ${shellArg(secondMember)}
wait_location ${shellArg(moveInstance)} ${shellArg(secondMember)}
wait_running ${shellArg(moveInstance)}
terrariumctl cluster move ${shellArg(moveInstance)} ${shellArg(firstMember)}
wait_location ${shellArg(moveInstance)} ${shellArg(firstMember)}
wait_running ${shellArg(moveInstance)}

lxc launch ubuntu:24.04 ${shellArg(evacuateInstance)} --target ${shellArg(secondMember)}
wait_running ${shellArg(evacuateInstance)}
terrariumctl cluster evacuate ${shellArg(secondMember)} --yes
wait_location ${shellArg(evacuateInstance)} ${shellArg(firstMember)}
wait_running ${shellArg(evacuateInstance)}

terrariumctl cluster restore ${shellArg(secondMember)} --yes
lxc launch ubuntu:24.04 ${shellArg(restoreProbeInstance)} --target ${shellArg(secondMember)}
wait_running ${shellArg(restoreProbeInstance)}
wait_location ${shellArg(restoreProbeInstance)} ${shellArg(secondMember)}
`.trim();

  try {
    await host.exec(`bash -lc ${shellArg(script)}`, { timeoutMs: 30 * 60 * 1000 });
  } finally {
    await host.execAllowFailure(`lxc delete ${shellArg(moveInstance)} --force`, { timeoutMs: 120000 });
    await host.execAllowFailure(`lxc delete ${shellArg(evacuateInstance)} --force`, { timeoutMs: 120000 });
    await host.execAllowFailure(`lxc delete ${shellArg(restoreProbeInstance)} --force`, { timeoutMs: 120000 });
  }
}

async function verifyTerrariumCluster(context: IntegrationContext, sshKeyId: number): Promise<void> {
  const seed = await provisionHost(context, { label: "cluster-seed", withVolume: false }, sshKeyId);
  const joiner = await provisionHost(context, { label: "cluster-join", withVolume: false }, sshKeyId);
  const seedSsh = context.ssh(seed);
  const joinSsh = context.ssh(joiner);
  const seedMember = "cluster-seed";
  const joinMember = "cluster-join";

  try {
    await context.publicDns.waitForHosts(
      [seed.domains.manage, seed.domains.proxy, seed.domains.lxd, seed.domains.auth],
      seed.server.ipv4
    );
    await context.publicDns.waitForHosts(
      [joiner.domains.manage, joiner.domains.proxy, joiner.domains.lxd, joiner.domains.auth],
      joiner.server.ipv4
    );

    const fixture = await context.provisionZitadelFixture(
      `${context.config.slug}-cluster`,
      seed.domains,
      "terrarium-admins",
      [],
      [joiner.domains]
    );

    await installTerrarium(context, seed, {
      idpMode: "oidc",
      storageMode: "file",
      storageSize: "32G",
      oidcIssuer: context.config.zitadelCloudIssuer,
      oidcClientId: fixture.clientId,
      oidcClientSecret: fixture.clientSecret,
      lxdOidcClientId: fixture.lxdClientId,
      lxdOidcClientSecret: fixture.lxdClientSecret,
      adminGroup: fixture.adminGroup
    });
    await installTerrarium(context, joiner, {
      idpMode: "oidc",
      storageMode: "file",
      storageSize: "32G",
      oidcIssuer: context.config.zitadelCloudIssuer,
      oidcClientId: fixture.clientId,
      oidcClientSecret: fixture.clientSecret,
      lxdOidcClientId: fixture.lxdClientId,
      lxdOidcClientSecret: fixture.lxdClientSecret,
      adminGroup: fixture.adminGroup
    });

    await assertInstalledHost(seedSsh);
    await assertInstalledHost(joinSsh);

    await seedSsh.exec(`terrariumctl cluster init --member ${shellArg(seedMember)}`, {
      timeoutMs: 30 * 60 * 1000
    });
    await waitForClusterMembers(seedSsh, [seedMember]);

    const inviteOutput = await seedSsh.exec(`terrariumctl cluster invite ${shellArg(joinMember)} ${shellArg(joiner.server.ipv4)}`, {
      timeoutMs: 120000
    });
    const joinCommand = inviteOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("terrariumctl cluster join "));
    if (!joinCommand) {
      throw new Error(`cluster invite did not print a join command: ${lastNonEmptyLine(inviteOutput)}`);
    }

    await joinSsh.exec(`${joinCommand} --yes`, { timeoutMs: 30 * 60 * 1000 });

    await waitForClusterMembers(seedSsh, [seedMember, joinMember]);
    await waitForClusterMembers(joinSsh, [seedMember, joinMember]);
    await seedSsh.exec("terrariumctl cluster ovn configure", { timeoutMs: 30 * 60 * 1000 });
    await expectRemoteContains(seedSsh, "terrariumctl cluster status", "terrarium-ovn");
    await expectRemoteContains(joinSsh, "terrariumctl cluster status", "terrarium-ovn");
    await expectRemoteContains(joinSsh, "grep -F 'terrarium_cluster_enabled: true' /etc/terrarium/config.yaml", "terrarium_cluster_enabled: true");
    await verifyClusterOvnWorkloads(seedSsh, seedMember, joinMember, context.config.slug);
    await verifyClusterWorkloadOperations(seedSsh, seedMember, joinMember, context.config.slug);
    await verifyClusterRemoveWithMove(seedSsh, seedMember, joinMember, context.config.slug);
  } catch (error) {
    await captureFailureArtifacts(context, [seed, joiner]);
    throw error;
  }
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

    await fileSsh.exec(`lxc launch ubuntu:24.04 ${sharedContainer}`);
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
  let releasedFullHosts = false;

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

    await context.releaseHetznerHost(fileHost);
    await context.releaseHetznerHost(partitionHost);
    releasedFullHosts = true;

    await verifyTerrariumCluster(context, sshKeyId);
  } catch (error) {
    if (!releasedFullHosts) {
      await captureFailureArtifacts(context, [fileHost, partitionHost]);
    }
    throw error;
  }
}
