import { password } from "@inquirer/prompts";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { FSTAB_PATH, heading, label, ManagedMount, MOUNTS_DIR, MOUNT_MARKER_PREFIX, success, value } from "./context";
import { runAllowFailure, runText } from "../lib/common";
import { PREFIX } from "./context";

/** Options that control how a host SMB/CIFS mount is presented on the Terrarium host. */
export type MountAddOptions = {
  uid?: string;
  gid?: string;
  fileMode?: string;
  dirMode?: string;
  seal?: boolean;
};

/** Normalizes supported mount protocol aliases down to the real Linux fstype. */
function normalizeMountProtocol(protocol: string): "cifs" {
  const normalized = protocol.trim().toLowerCase();
  if (normalized === "cifs" || normalized === "smb") {
    return "cifs";
  }
  throw new Error("mount protocol must be smb or cifs");
}

/** Ensures SMB share addresses always use the canonical `//server/share` format. */
function normalizeShareAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) {
    throw new Error("share address is required");
  }
  if (trimmed.startsWith("//")) {
    return trimmed;
  }
  return `//${trimmed.replace(/^\/+/, "")}`;
}

/** Prevents users from accidentally creating relative mount points on the host. */
function requireAbsoluteHostPath(hostPath: string): string {
  const trimmed = hostPath.trim();
  if (!trimmed.startsWith("/")) {
    throw new Error("host path must be absolute");
  }
  return trimmed;
}

/** Creates a stable mount identifier from host path and share address. */
function slugifyMountName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "mount";
}

/** Escapes arbitrary text so it can be embedded safely into a dynamic regular expression. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces a Terrarium-managed fstab block while leaving other entries untouched. */
function replaceManagedBlock(current: string, marker: string, block: string): string {
  const pattern = new RegExp(`# BEGIN ${escapeRegex(marker)}\\n[\\s\\S]*?# END ${escapeRegex(marker)}\\n?`, "g");
  const cleaned = current.replace(pattern, "").replace(/\n{3,}/g, "\n\n").trimEnd();
  return `${cleaned ? `${cleaned}\n\n` : ""}${block}\n`;
}

/** Removes a Terrarium-managed fstab block while preserving unrelated entries. */
function stripManagedBlock(current: string, marker: string): string {
  const pattern = new RegExp(`# BEGIN ${escapeRegex(marker)}\\n[\\s\\S]*?# END ${escapeRegex(marker)}\\n?`, "g");
  return current.replace(pattern, "").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/**
 * Parses all Terrarium-managed host mounts from `/etc/fstab`.
 *
 * Terrarium owns only blocks wrapped with its marker comments, which lets list
 * and remove operate safely without interfering with user-managed fstab lines.
 */
function parseManagedMounts(current: string): ManagedMount[] {
  const mounts: ManagedMount[] = [];
  const pattern = new RegExp(`# BEGIN (${escapeRegex(MOUNT_MARKER_PREFIX)}[^\\n]+)\\n([^\\n]+)\\n# END \\1`, "g");

  for (const match of current.matchAll(pattern)) {
    const marker = match[1]?.trim() ?? "";
    const entry = match[2]?.trim() ?? "";
    if (!marker || !entry) {
      continue;
    }

    const [address = "", hostPath = "", protocol = "", rawOptions = ""] = entry.split(/\s+/, 4);
    if (!address || !hostPath || !protocol) {
      continue;
    }

    const options = rawOptions.split(",").filter(Boolean);
    const credentialsPath = options.find((option) => option.startsWith("credentials="))?.slice("credentials=".length) ?? "";

    mounts.push({
      marker,
      address,
      hostPath,
      protocol,
      options,
      credentialsPath
    });
  }

  return mounts;
}

/**
 * Creates or updates a Terrarium-managed host SMB/CIFS mount.
 *
 * The command writes a root-only credentials file, persists the mount in
 * `/etc/fstab`, and mounts the target immediately so it is ready for use by
 * containers or the host without a reboot.
 */
export async function mountAddCmd(
  protocolArg: string,
  hostPathArg: string,
  addressArg: string,
  usernameArg: string,
  passwordArg?: string,
  options: MountAddOptions = {}
): Promise<void> {
  const protocol = normalizeMountProtocol(protocolArg);
  const hostPath = requireAbsoluteHostPath(hostPathArg);
  const address = normalizeShareAddress(addressArg);
  const username = usernameArg.trim();
  if (!username) {
    throw new Error("username is required");
  }

  const secret =
    passwordArg ||
    (await password({
      message: `Password for ${username} (${address})`,
      mask: true,
      validate: (value) => (value.trim().length > 0 ? true : "Password is required")
    }));

  mkdirSync(MOUNTS_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(hostPath, { recursive: true, mode: 0o755 });

  const slug = slugifyMountName(`${hostPath}-${address}`);
  const credentialsPath = `${MOUNTS_DIR}/${slug}.credentials`;
  const marker = `${MOUNT_MARKER_PREFIX}${slug}`;
  const optionsList = [
    "iocharset=utf8",
    "rw",
    ...(options.seal === false ? [] : ["seal"]),
    `credentials=${credentialsPath}`,
    `uid=${options.uid || "0"}`,
    `gid=${options.gid || "0"}`,
    `file_mode=${options.fileMode || "0660"}`,
    `dir_mode=${options.dirMode || "0770"}`
  ];
  const entry = `${address} ${hostPath} ${protocol} ${optionsList.join(",")} 0 0`;
  const block = `# BEGIN ${marker}\n${entry}\n# END ${marker}`;

  writeFileSync(credentialsPath, `username=${username}\npassword=${secret}\n`, "utf8");
  chmodSync(credentialsPath, 0o600);

  const fstabCurrent = existsSync(FSTAB_PATH) ? readFileSync(FSTAB_PATH, "utf8") : "";
  writeFileSync(FSTAB_PATH, replaceManagedBlock(fstabCurrent, marker, block), "utf8");

  const mounted = await runAllowFailure(["mountpoint", "-q", hostPath]);
  if (mounted.exitCode === 0) {
    await runText(["umount", hostPath], PREFIX);
  }

  await runText(["mount", hostPath], PREFIX);

  console.log(success(`Mounted ${address} at ${hostPath}`));
  console.log(`  ${label("Protocol:")} ${value(protocol)}`);
  console.log(`  ${label("Credentials:")} ${value(credentialsPath)}`);
  console.log(`  ${label("fstab:")} ${value(`managed block ${marker}`)}`);
}

/** Lists every Terrarium-managed host mount currently registered in `/etc/fstab`. */
export async function mountListCmd(): Promise<void> {
  const fstabCurrent = existsSync(FSTAB_PATH) ? readFileSync(FSTAB_PATH, "utf8") : "";
  const mounts = parseManagedMounts(fstabCurrent);

  if (mounts.length === 0) {
    console.log("No Terrarium-managed mounts found.");
    return;
  }

  console.log(heading("Terrarium-managed mounts"));
  for (const mount of mounts) {
    const mounted = await runAllowFailure(["mountpoint", "-q", mount.hostPath]);
    console.log(`\n${label("Path:")} ${value(mount.hostPath)}`);
    console.log(`  ${label("Address:")} ${value(mount.address)}`);
    console.log(`  ${label("Protocol:")} ${value(mount.protocol)}`);
    console.log(`  ${label("Mounted:")} ${value(mounted.exitCode === 0 ? "yes" : "no")}`);
    console.log(`  ${label("Credentials:")} ${value(mount.credentialsPath || "n/a")}`);
  }
}

/**
 * Removes a Terrarium-managed host mount by mount point path.
 *
 * The removal process unmounts the share, removes the managed fstab block, and
 * deletes the corresponding managed credentials file.
 */
export async function mountRemoveCmd(hostPathArg: string, confirmDestructive: (message: string) => Promise<void>): Promise<void> {
  const hostPath = requireAbsoluteHostPath(hostPathArg);
  const fstabCurrent = existsSync(FSTAB_PATH) ? readFileSync(FSTAB_PATH, "utf8") : "";
  const mounts = parseManagedMounts(fstabCurrent);
  const mount = mounts.find((candidate) => candidate.hostPath === hostPath);

  if (!mount) {
    throw new Error(`no Terrarium-managed mount found for ${hostPath}`);
  }

  await confirmDestructive(`Remove managed mount ${mount.address} at ${hostPath}?`);

  const mounted = await runAllowFailure(["mountpoint", "-q", hostPath]);
  if (mounted.exitCode === 0) {
    await runText(["umount", hostPath], PREFIX);
  }

  writeFileSync(FSTAB_PATH, `${stripManagedBlock(fstabCurrent, mount.marker)}\n`, "utf8");

  if (mount.credentialsPath && existsSync(mount.credentialsPath)) {
    unlinkSync(mount.credentialsPath);
  }

  console.log(success(`Removed managed mount at ${hostPath}`));
}
