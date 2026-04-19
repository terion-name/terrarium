import { SshHost } from "../remote/ssh";

/** Checks a command on the remote host and throws if the stdout does not include the expected text. */
export async function expectRemoteContains(host: SshHost, command: string, needle: string): Promise<void> {
  const stdout = await host.exec(command);
  if (!stdout.includes(needle)) {
    throw new Error(`expected remote command output to include "${needle}"`);
  }
}

/** Verifies that a systemd unit or timer is active on the managed host. */
export async function expectSystemdActive(host: SshHost, unit: string): Promise<void> {
  const stdout = await host.exec(`systemctl is-active ${unit}`);
  if (stdout.trim() !== "active") {
    throw new Error(`expected ${unit} to be active, got: ${stdout.trim()}`);
  }
}
