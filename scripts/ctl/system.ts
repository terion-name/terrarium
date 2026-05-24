import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_PATH, PREFIX } from "./context";
import { runInteractive } from "../lib/common";
import { exportClusterStoreToConfigFile } from "../lib/config-store";

export type ReconfigureOptions = {
  applyHardening?: boolean;
};

const BLOCKING_STDIO_EXEC = `
import fcntl
import os
import sys

for fd in (0, 1, 2):
    try:
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags & ~os.O_NONBLOCK)
    except OSError:
        pass

os.execvp(sys.argv[1], sys.argv[1:])
`;

/**
 * Re-runs the installed Ansible reconciliation against the persisted host config.
 *
 * This is the command Terrarium uses for day-2 convergence after config changes.
 */
export async function reconfigureCmd(options: ReconfigureOptions = {}): Promise<void> {
  if (!existsSync("/opt/terrarium/ansible/site.yml")) {
    throw new Error("/opt/terrarium/ansible/site.yml not found");
  }
  if (!existsSync("/opt/terrarium/dist/terrariumctl")) {
    throw new Error("compiled Terrarium binaries are missing from /opt/terrarium/dist; rerun install.sh");
  }

  const tempDir = mkdtempSync(join(tmpdir(), "terrarium-reconfigure-"));
  const tempConfigPath = join(tempDir, "config.yaml");
  let ansibleConfigPath = tempConfigPath;
  let exportedFromClusterStore = false;

  try {
    console.log(`${PREFIX}: exporting saved configuration to a temporary Ansible vars file`);
    exportedFromClusterStore = exportClusterStoreToConfigFile(tempConfigPath, PREFIX);
    if (!exportedFromClusterStore) {
      if (!existsSync(CONFIG_PATH)) {
        throw new Error("Terrarium config was not found in the LXD dqlite store or legacy local export");
      }
      ansibleConfigPath = CONFIG_PATH;
    }

    const args = ["ansible-playbook", "-i", "inventory.ini", "site.yml", "-e", `@${ansibleConfigPath}`];
    if (options.applyHardening === false) {
      args.push("-e", "terrarium_apply_hardening=false");
    }

    console.log(`${PREFIX}: running Ansible reconciliation`);
    await runInteractive(["python3", "-c", BLOCKING_STDIO_EXEC, ...args], PREFIX, { cwd: "/opt/terrarium/ansible" });
    console.log(`${PREFIX}: reconfigure finished`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    if (exportedFromClusterStore) {
      rmSync(CONFIG_PATH, { force: true });
    }
  }
}
