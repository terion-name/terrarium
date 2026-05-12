import { existsSync } from "node:fs";
import { CONFIG_PATH, PREFIX } from "./context";
import { runInteractive } from "../lib/common";
import { exportClusterStoreToConfigFile } from "../lib/config-store";

export type ReconfigureOptions = {
  applyHardening?: boolean;
};

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

  console.log(`${PREFIX}: exporting saved configuration to ${CONFIG_PATH}`);
  exportClusterStoreToConfigFile(CONFIG_PATH, PREFIX);

  const args = ["ansible-playbook", "-i", "inventory.ini", "site.yml", "-e", `@${CONFIG_PATH}`];
  if (options.applyHardening === false) {
    args.push("-e", "terrarium_apply_hardening=false");
  }

  console.log(`${PREFIX}: running Ansible reconciliation`);
  await runInteractive(args, PREFIX, { cwd: "/opt/terrarium/ansible" });
  console.log(`${PREFIX}: reconfigure finished`);
}
