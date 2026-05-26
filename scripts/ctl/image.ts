import { heading, label, success, value } from "./context";
import { runAllowFailure, runInteractive, runText } from "../lib/common";
import { launchCmd, LaunchOptions } from "./launch";
import { PREFIX } from "./context";

const LXC = process.env.TERRARIUM_LXC_BIN ?? "/snap/bin/lxc";

export type ImageCreateOptions = {
  snapshot?: string;
  live?: boolean;
  reuse?: boolean;
};

export type ImageCreatePlan = {
  instance: string;
  alias: string;
  source: string;
  tempInstance: string;
  snapshotToCreate?: string;
  publishArgs: string[];
};

type ImageCreateIdentity = {
  now?: number;
  pid?: number;
};

type LxdConfig = {
  devices?: Record<string, { type?: string }>;
};

function requireName(value: string, labelName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${labelName} is required`);
  }
  return trimmed;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "image"
  );
}

export function buildImageCreatePlan(
  instanceArg: string,
  aliasArg: string,
  options: ImageCreateOptions = {},
  identity: ImageCreateIdentity = {}
): ImageCreatePlan {
  const instance = requireName(instanceArg, "instance");
  const alias = requireName(aliasArg, "image alias");
  const snapshot = options.snapshot?.trim();
  if (snapshot && options.live) {
    throw new Error("use either --snapshot or --live, not both");
  }

  const now = identity.now ?? Date.now();
  const pid = identity.pid ?? process.pid;
  const snapshotToCreate = snapshot || options.live ? undefined : `terrarium-golden-${now}`;
  const source = snapshot ? `${instance}/${snapshot}` : options.live ? instance : `${instance}/${snapshotToCreate}`;
  const tempInstance = `terrarium-image-${slugify(alias)}-${pid}-${now}`;
  const publishArgs = [LXC, "publish", tempInstance, "--alias", alias];
  if (options.reuse) {
    publishArgs.push("--reuse");
  }

  return {
    instance,
    alias,
    source,
    tempInstance,
    ...(snapshotToCreate ? { snapshotToCreate } : {}),
    publishArgs
  };
}

async function proxyDeviceNames(instance: string): Promise<string[]> {
  const raw = await runAllowFailure([LXC, "config", "show", instance, "--format=json"]);
  if (raw.exitCode !== 0) {
    return [];
  }

  let parsed: LxdConfig;
  try {
    parsed = JSON.parse(raw.stdout) as LxdConfig;
  } catch {
    return [];
  }

  return Object.entries(parsed.devices ?? {})
    .filter(([, device]) => device?.type === "proxy")
    .map(([name]) => name);
}

async function sanitizeImageSource(instance: string): Promise<void> {
  await runAllowFailure([LXC, "config", "unset", instance, "user.proxy"]);
  for (const device of await proxyDeviceNames(instance)) {
    await runAllowFailure([LXC, "config", "device", "remove", instance, device]);
  }
}

export async function imageCreateCmd(instance: string, alias: string, options: ImageCreateOptions = {}): Promise<void> {
  const plan = buildImageCreatePlan(instance, alias, options);
  let createdTemp = false;
  let createdSnapshot = false;

  try {
    if (plan.snapshotToCreate) {
      await runText([LXC, "snapshot", plan.instance, plan.snapshotToCreate], PREFIX);
      createdSnapshot = true;
    }

    await runText([LXC, "copy", plan.source, plan.tempInstance], PREFIX);
    createdTemp = true;
    await sanitizeImageSource(plan.tempInstance);
    await runInteractive(plan.publishArgs, PREFIX);
  } finally {
    if (createdTemp) {
      await runAllowFailure([LXC, "delete", plan.tempInstance, "--force"]);
    }
    if (createdSnapshot && plan.snapshotToCreate) {
      await runAllowFailure([LXC, "delete", `${plan.instance}/${plan.snapshotToCreate}`]);
    }
  }

  console.log(success(`Created golden image ${plan.alias}`));
  console.log(`  ${label("Source:")} ${value(plan.source)}`);
}

export async function imageListCmd(): Promise<void> {
  console.log(heading("LXD images"));
  await runInteractive([LXC, "image", "list"], PREFIX);
}

export async function imageLaunchCmd(alias: string, name: string, options: LaunchOptions = {}): Promise<void> {
  await launchCmd(alias, name, options);
}

export async function imageDeleteCmd(aliasArg: string): Promise<void> {
  const alias = requireName(aliasArg, "image alias");
  await runInteractive([LXC, "image", "delete", alias], PREFIX);
}
