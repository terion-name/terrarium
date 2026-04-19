import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { IntegrationContext } from "./context";
import type { ManagedHost } from "./types";

/** Collects a compact but high-value artifact bundle from a managed host. */
export async function collectHostArtifacts(context: IntegrationContext, host: ManagedHost): Promise<void> {
  const ssh = context.ssh(host);
  const outputPath = join(context.localArtifactsDir, `${host.label}.tar.gz`);
  mkdirSync(context.localArtifactsDir, { recursive: true });
  await ssh.archive(
    [
      "/etc/terrarium",
      "/etc/traefik",
      "/var/lib/terrarium",
      "/var/log",
      "/etc/systemd/system/terrarium*",
      "/etc/systemd/system/traefik.service"
    ],
    outputPath
  );

  const journals = await ssh.exec(
    "journalctl -u traefik -u terrarium-oauth2-proxy.service -u terrarium-zitadel.service -u terrarium-traefik-sync.service -u terrarium-s3-backup.service -u terrarium-syncoid.service --no-pager -n 200 || true"
  );
  await Bun.write(join(context.localArtifactsDir, `${host.label}-journal.log`), journals);
}
