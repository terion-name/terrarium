import { existsSync } from "node:fs";
import { CONFIG_PATH, PREFIX } from "./context";
import { runText } from "../lib/common";

/**
 * Re-runs the installed Ansible reconciliation against the persisted host config.
 *
 * This is the command Terrarium uses for day-2 convergence after config changes.
 */
export async function reconfigureCmd(): Promise<void> {
  if (!existsSync("/opt/terrarium/ansible/site.yml")) {
    throw new Error("/opt/terrarium/ansible/site.yml not found");
  }
  if (!existsSync("/opt/terrarium/dist/terrariumctl")) {
    throw new Error("compiled Terrarium binaries are missing from /opt/terrarium/dist; rerun install.sh");
  }

  await runText(
    ["ansible-playbook", "-i", "/opt/terrarium/ansible/inventory.ini", "/opt/terrarium/ansible/site.yml", "-e", `@${CONFIG_PATH}`],
    PREFIX,
    { cwd: "/opt/terrarium" }
  );
}
