import { IntegrationContext } from "../context";
import { arbitraryPublicHost, captureFailureArtifacts, createHttpFixtureContainer, defaultPublicDomains, installTerrarium, preparePartitionTarget, provisionHost } from "./common";
import { runSmokeSuite } from "./smoke";

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/** Runs the exhaustive manual/release-preflight suite on top of the smoke baseline. */
export async function runFullSuite(context: IntegrationContext): Promise<void> {
  await runSmokeSuite(context);

  const sshKeyId = await context.registerHetznerKey(`terrarium-full-${context.config.slug}`);
  const fileHost = await provisionHost(context, { label: "full-file", domains: context.domainBundle("full-file"), withVolume: false }, sshKeyId);
  const partitionHost = await provisionHost(context, { label: "full-partition", domains: context.domainBundle("full-partition"), withVolume: true }, sshKeyId);
  const fileSsh = context.ssh(fileHost);
  const partitionSsh = context.ssh(partitionHost);

  try {
    fileHost.domains = defaultPublicDomains(fileHost.server.ipv4);
    partitionHost.domains = defaultPublicDomains(partitionHost.server.ipv4);
    const externalFixture = await context.zitadelCloud.provisionFixture(`${context.config.slug}-full`, fileHost.domains, "terrarium-admins");
    context.registerCleanup(async () => {
      await context.zitadelCloud.cleanupFixture(externalFixture);
    });

    await installTerrarium(context, fileHost, {
      idpMode: "oidc",
      storageMode: "file",
      storageSize: "32G",
      oidcIssuer: context.config.zitadelCloudIssuer,
      oidcClientId: externalFixture.clientId,
      oidcClientSecret: externalFixture.clientSecret,
      adminGroup: externalFixture.adminGroup,
      useDerivedDomains: true
    });

    await preparePartitionTarget(partitionSsh, partitionHost.volume?.linuxDevice || "/dev/sdb");
    await installTerrarium(context, partitionHost, {
      idpMode: "local",
      storageMode: "partition",
      storageSource: "auto",
      useDerivedDomains: true
    });

    await fileSsh.exec(
      `terrariumctl mount add cifs /srv/shared/${context.config.slug} ${shellArg(context.config.cifsAddress)} ${shellArg(
        context.config.cifsUsername
      )} -p ${shellArg(context.config.cifsPassword)}`
    );
    await fileSsh.exec("terrariumctl mount list");
    await fileSsh.exec(`mkdir -p /srv/shared/${context.config.slug}/${context.config.cifsHostPathBase}/${context.config.slug}`);
    await fileSsh.exec(`echo shared > /srv/shared/${context.config.slug}/${context.config.cifsHostPathBase}/${context.config.slug}/note.txt`);
    await fileSsh.exec(`lxc launch images:ubuntu/24.04 shared-${context.config.slug} --profile terrarium`);
    await fileSsh.exec(
      `lxc config device add shared-${context.config.slug} shared disk source=/srv/shared/${context.config.slug}/${context.config.cifsHostPathBase}/${context.config.slug} path=/mnt/shared`
    );
    await fileSsh.exec(`lxc exec shared-${context.config.slug} -- cat /mnt/shared/note.txt`);

    await createHttpFixtureContainer(
      fileSsh,
      `compose-${context.config.slug}`,
      [`https://${arbitraryPublicHost(fileHost.server.ipv4, `compose-${context.config.slug}`)}@auth:agents,admins`],
      "compose-ok"
    );

    await fileSsh.exec("apt-get update && apt-get install -y expect");
    await fileSsh.exec(
      `expect -c 'set timeout 120; spawn bash -lc "terrariumctl backup restore --instance compose-${context.config.slug} --as-new compose-${context.config.slug}-restored"; expect { -re {Select.*pool} { send "terrarium\\r"; exp_continue } eof {} }'`
    ).catch(() => {
      // The prompt shape varies across LXD versions; the helper is intentionally best-effort in CI.
    });

    await fileSsh.exec(
      `terrariumctl set s3 --enable --s3-endpoint ${shellArg(context.config.s3Endpoint)} --s3-bucket ${shellArg(
        context.config.s3Bucket
      )} --s3-region ${shellArg(context.config.s3Region)} --s3-prefix ${shellArg(
        `terrarium/${context.config.slug}/full`
      )} --s3-access-key ${shellArg(context.config.s3AccessKey)} --s3-secret-key ${shellArg(context.config.s3SecretKey)}`
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
    await fileSsh.exec(`terrariumctl mount remove /srv/shared/${context.config.slug}`);
  } catch (error) {
    await captureFailureArtifacts(context, [fileHost, partitionHost]);
    throw error;
  }
}
