import { confirm, input } from "@inquirer/prompts";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { configString, runAllowFailure, runText, shellEscape } from "../lib/common";
import {
  CONFIG_PATH,
  loadMutableConfig,
  MutableConfig,
  saveMutableConfig,
  setConfigValue,
  success
} from "./context";
import { exportClusterStoreToConfigFile, importConfigFileToClusterStore } from "../lib/config-store";
import { reconfigureCmd } from "./system";

const PREFIX = "terrariumctl cluster";
const DEFAULT_CLUSTER_PORT = "8443";
const DEFAULT_OVN_NETWORK = "terrarium-ovn";
const DEFAULT_OVN_PARENT = "lxdbr0";
const DEFAULT_STORAGE_POOL = "terrarium";
const DEFAULT_STATE_DIR = "/var/lib/terrarium";
const LXC = process.env.TERRARIUM_LXC_BIN ?? "/snap/bin/lxc";
const LXD = process.env.TERRARIUM_LXD_BIN ?? "/snap/bin/lxd";
const UFW = process.env.TERRARIUM_UFW_BIN ?? "ufw";
const ZPOOL = process.env.TERRARIUM_ZPOOL_BIN ?? "zpool";
const MKDIR = process.env.TERRARIUM_MKDIR_BIN ?? "mkdir";
const RM = process.env.TERRARIUM_RM_BIN ?? "rm";
const TRUNCATE = process.env.TERRARIUM_TRUNCATE_BIN ?? "truncate";
const IP = process.env.TERRARIUM_IP_BIN ?? "ip";
const HOSTNAME = process.env.TERRARIUM_HOSTNAME_BIN ?? "hostname";
const TIMEOUT = process.env.TERRARIUM_TIMEOUT_BIN ?? "timeout";
const GETENT = process.env.TERRARIUM_GETENT_BIN ?? "getent";
const SYSTEMD_RUN = process.env.TERRARIUM_SYSTEMD_RUN_BIN ?? "systemd-run";
const TERRARIUMCTL = process.env.TERRARIUMCTL_BIN ?? "/usr/local/bin/terrariumctl";
const OPENSSL = process.env.TERRARIUM_OPENSSL_BIN ?? "openssl";
const CLUSTER_FIREWALL_RULES = [
  { port: "8443", proto: "tcp" },
  { port: "6081", proto: "udp" },
  { port: "6641", proto: "tcp" },
  { port: "6642", proto: "tcp" }
] as const;
const PENDING_INVITES_KEY = "terrarium_cluster_pending_peer_invites";

export type ClusterInitOptions = {
  member?: string;
  address?: string;
  network?: string;
  parent?: string;
  centralAddresses?: string;
  peerCidr?: string;
  skipReconfigure?: boolean;
};

export type ClusterJoinOptions = {
  token?: string;
  address?: string;
  storagePool?: string;
  peerCidr?: string;
  yes?: boolean;
  skipExport?: boolean;
  skipReconfigure?: boolean;
};

export type ClusterInviteOptions = {
  peerCidr?: string;
};

export type ClusterInviteCleanupOptions = {
  peerCidr?: string;
  expiresAt?: string;
};

export type ClusterOvnOptions = {
  network?: string;
  parent?: string;
  centralAddresses?: string;
  peerCidr?: string;
  skipReconfigure?: boolean;
};

export type ClusterRemoveOptions = {
  move?: boolean;
  target?: string;
  force?: boolean;
  yes?: boolean;
  skipReconfigure?: boolean;
};

export type ClusterMemberActionOptions = {
  yes?: boolean;
};

type JoinPreseedOptions = {
  serverAddress: string;
  clusterToken: string;
  storagePool: string;
};

type JoinStorageConfig = {
  pool: string;
  mode: string;
  source: string;
  size: string;
};

type AddressCandidate = {
  address: string;
  cidr: string;
  ifname: string;
  family: "inet" | "inet6";
  private: boolean;
};

type DiscoveredClusterNetwork = {
  address: string;
  peerCidr?: string;
  ifname?: string;
};

export type ClusterMember = {
  name?: string;
  address: string;
  online: boolean;
};

export type ClusterWorkload = {
  name: string;
  status?: string;
  location?: string;
};

export type ClusterMemberPlacement = {
  member: string;
  workloadCount: number;
  plannedWorkloadCount: number;
  memoryUsed?: number;
  memoryTotal?: number;
};

export type ClusterMovePlanItem = {
  workload: ClusterWorkload;
  target: string;
};

type PendingClusterInvite = {
  peer_cidr: string;
  expires_at: string;
};

type OvnCaMaterial = {
  cert: string;
  key: string;
};

export function normalizeClusterEndpoint(value: string, defaultPort = DEFAULT_CLUSTER_PORT): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("cluster address is required");
  }
  if (trimmed.startsWith("[") && trimmed.includes("]:")) {
    return trimmed;
  }
  if (/^[^:]+:\d+$/.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}:${defaultPort}`;
}

export function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parsePeerCidrs(value: string | undefined): string[] {
  return parseCsv(value).map((item) => {
    if (item.includes("/")) {
      return item;
    }
    return exactPeerCidrForHost(endpointHost(item)) ?? item;
  });
}

export function endpointHost(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (/^https?:\/\//.test(trimmed)) {
    const host = new URL(trimmed).hostname;
    return host.replace(/^\[|\]$/g, "");
  }

  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }

  const colonCount = [...trimmed].filter((char) => char === ":").length;
  if (colonCount === 1 && /:\d+$/.test(trimmed)) {
    return trimmed.replace(/:\d+$/, "");
  }
  return trimmed;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [first, second] = parts;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function isIgnoredClusterInterface(ifname: string): boolean {
  return /^(lo|lxdbr\d*|docker\d*|br-|veth|virbr\d*|cni|flannel|zt)/.test(ifname);
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function exactPeerCidrForHost(host: string): string | null {
  if (ipv4ToInt(host) !== null) {
    return `${host}/32`;
  }
  if (host.includes(":")) {
    return `${host}/128`;
  }
  return null;
}

export function decodeLxdJoinToken(token: string): { addresses: string[]; serverName?: string; expiresAt?: string } {
  const normalized = token.trim();
  if (!normalized) {
    throw new Error("cluster token is empty");
  }

  const padded = normalized.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as { addresses?: unknown; server_name?: unknown; expires_at?: unknown };
  const expiresAt = typeof parsed.expires_at === "string" ? parsed.expires_at : undefined;
  const addresses = Array.isArray(parsed.addresses) ? parsed.addresses.filter((item): item is string => typeof item === "string") : [];
  const decoded: { addresses: string[]; serverName?: string; expiresAt?: string } = {
    addresses,
    serverName: typeof parsed.server_name === "string" ? parsed.server_name : undefined
  };
  if (expiresAt) {
    decoded.expiresAt = expiresAt;
  }
  return decoded;
}

export function peerCidrsFromJoinToken(token: string): string[] {
  return decodeLxdJoinToken(token)
    .addresses.map((address) => exactPeerCidrForHost(endpointHost(address)))
    .filter((cidr): cidr is string => cidr !== null);
}

export function peerCidrsFromHostsOutput(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/)[0])
        .map((host) => (host ? exactPeerCidrForHost(host) : null))
        .filter((cidr): cidr is string => cidr !== null)
    )
  ];
}

export function addressCandidatesFromIpJson(value: string): AddressCandidate[] {
  const interfaces = JSON.parse(value || "[]") as Array<{
    ifname?: unknown;
    addr_info?: Array<{ family?: unknown; local?: unknown; prefixlen?: unknown; scope?: unknown }>;
  }>;

  return interfaces.flatMap((networkInterface) => {
    const ifname = typeof networkInterface.ifname === "string" ? networkInterface.ifname : "";
    if (!ifname || isIgnoredClusterInterface(ifname)) {
      return [];
    }

    return (networkInterface.addr_info ?? []).flatMap((address) => {
      if (address.family !== "inet" && address.family !== "inet6") {
        return [];
      }
      if (address.scope !== undefined && address.scope !== "global") {
        return [];
      }
      if (typeof address.local !== "string" || typeof address.prefixlen !== "number") {
        return [];
      }
      return [
        {
          address: address.local,
          cidr: `${address.local}/${address.prefixlen}`,
          ifname,
          family: address.family,
          private: address.family === "inet" && isPrivateIpv4(address.local)
        }
      ];
    });
  });
}

export function bestPeerCidrForAddress(candidate: AddressCandidate): string | undefined {
  return exactPeerCidrForHost(candidate.address) ?? candidate.cidr;
}

export function selectClusterAddressCandidate(candidates: AddressCandidate[], routeSource?: string): AddressCandidate | null {
  if (routeSource) {
    const routed = candidates.find((candidate) => candidate.address === routeSource);
    if (routed) {
      return routed;
    }
  }

  return (
    candidates.find((candidate) => candidate.family === "inet" && candidate.private) ??
    candidates.find((candidate) => candidate.family === "inet") ??
    candidates[0] ??
    null
  );
}

export function clusterMembersFromJson(value: string, options: { onlineOnly?: boolean } = {}): ClusterMember[] {
  const members = JSON.parse(value || "[]") as Array<{ server_name?: unknown; status?: unknown; url?: unknown }>;
  return members
    .map((member): ClusterMember | null => {
      if (typeof member.url !== "string" || !member.url.trim()) {
        return null;
      }
      return {
        name: typeof member.server_name === "string" ? member.server_name : undefined,
        address: endpointHost(member.url),
        online: typeof member.status !== "string" || member.status.toLowerCase() === "online"
      };
    })
    .filter(
      (member): member is ClusterMember =>
        member !== null && member.address.length > 0 && (options.onlineOnly === false || member.online)
    );
}

export function clusterMemberAddressesFromJson(value: string): string[] {
  return [...new Set(clusterMembersFromJson(value).map((member) => member.address))];
}

export function selectOvnCentralAddresses(addresses: string[]): string[] {
  const unique = [...new Set(addresses.map((address) => address.trim()).filter(Boolean))];
  if (unique.length <= 1) {
    return unique;
  }
  return unique.slice(0, unique.length % 2 === 0 ? unique.length - 1 : unique.length);
}

export function instanceNamesFromLxcListJson(value: string): string[] {
  return instancesFromLxcListJson(value).map((instance) => instance.name);
}

export function instancesFromLxcListJson(value: string): ClusterWorkload[] {
  const instances = JSON.parse(value || "[]") as Array<{ name?: unknown; status?: unknown; location?: unknown }>;
  return instances
    .map((instance): ClusterWorkload | null => {
      if (typeof instance.name !== "string" || instance.name.length === 0) {
        return null;
      }
      const workload: ClusterWorkload = { name: instance.name };
      if (typeof instance.status === "string") {
        workload.status = instance.status;
      }
      if (typeof instance.location === "string") {
        workload.location = instance.location;
      }
      return workload;
    })
    .filter((instance): instance is ClusterWorkload => instance !== null);
}

export function memoryLoadFromResourcesJson(value: string): { used?: number; total?: number } {
  const parsed = JSON.parse(value || "{}") as { memory?: { used?: unknown; total?: unknown } };
  return {
    used: typeof parsed.memory?.used === "number" ? parsed.memory.used : undefined,
    total: typeof parsed.memory?.total === "number" ? parsed.memory.total : undefined
  };
}

function placementScore(candidate: ClusterMemberPlacement): number {
  const memoryRatio =
    typeof candidate.memoryUsed === "number" && typeof candidate.memoryTotal === "number" && candidate.memoryTotal > 0
      ? candidate.memoryUsed / candidate.memoryTotal
      : 0;

  return candidate.plannedWorkloadCount * 1000 + memoryRatio;
}

export function buildWorkloadMovePlan(workloads: ClusterWorkload[], candidates: ClusterMemberPlacement[]): ClusterMovePlanItem[] {
  if (workloads.length === 0) {
    return [];
  }
  if (candidates.length === 0) {
    throw new Error("no online cluster member is available to receive workloads");
  }

  return workloads.map((workload) => {
    const target = candidates
      .slice()
      .sort((left, right) => placementScore(left) - placementScore(right) || left.member.localeCompare(right.member))[0];
    target.plannedWorkloadCount += 1;
    return {
      workload,
      target: target.member
    };
  });
}

function configStringArray(config: MutableConfig, key: string): string[] {
  const value = config[key];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  if (typeof value === "string") {
    return parseCsv(value);
  }
  return [];
}

function ovnEndpointHost(address: string): string {
  return address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
}

export function ovnDbEndpoints(addresses: string[], port: "6641" | "6642", scheme = "ssl"): string {
  return addresses.map((address) => `${scheme}:${ovnEndpointHost(address)}:${port}`).join(",");
}

export function buildJoinPreseed(options: JoinPreseedOptions): string {
  return stringify({
    cluster: {
      enabled: true,
      server_address: options.serverAddress,
      cluster_token: options.clusterToken,
      member_config: [
        {
          entity: "storage-pool",
          name: options.storagePool,
          key: "source",
          value: options.storagePool
        }
      ]
    }
  });
}

function nonEmptyLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function extractLxdJoinToken(output: string): string {
  const token = nonEmptyLines(output).pop();

  if (!token || /\s/.test(token)) {
    throw new Error("LXD cluster add did not return a parseable join token");
  }
  return token;
}

export function partitionDeviceForStorageSource(source: string): string {
  return /nvme[0-9]+n[0-9]+$/.test(source) ? `${source}p1` : `${source}1`;
}

export function resolveJoinStorageConfig(config: MutableConfig, pool: string): JoinStorageConfig {
  const stateDir = configString(config, "terrarium_state_dir", DEFAULT_STATE_DIR);
  const mode = configString(config, "terrarium_storage_mode", "file");
  const size = configString(config, "terrarium_storage_size", "64G");

  if (mode === "file") {
    return {
      pool,
      mode,
      source: `${stateDir}/storage/${pool}.img`,
      size
    };
  }

  const configuredSource = configString(config, "terrarium_storage_source");
  if (mode === "partition" && configuredSource) {
    const start = configString(config, "terrarium_storage_partition_start");
    const end = configString(config, "terrarium_storage_partition_end");
    return {
      pool,
      mode,
      source: start && end ? partitionDeviceForStorageSource(configuredSource) : configuredSource,
      size
    };
  }

  return {
    pool,
    mode,
    source: configuredSource,
    size
  };
}

export function applyClusterConfig(config: MutableConfig, options: { network: string; parent: string; centralAddresses: string[]; peerCidrs: string[] }): void {
  setConfigValue(config, "terrarium_cluster_enabled", true);
  setConfigValue(config, "terrarium_lxd_network_name", options.network);
  setConfigValue(config, "terrarium_lxd_network_parent", options.parent);
  setConfigValue(config, "terrarium_ovn_central_addresses", options.centralAddresses);
  setConfigValue(config, "terrarium_cluster_peer_cidrs", options.peerCidrs);
}

async function createOvnCaMaterial(): Promise<OvnCaMaterial> {
  const dir = mkdtempSync(join(tmpdir(), "terrarium-ovn-ca-"));
  const keyPath = join(dir, "ca.key");
  const certPath = join(dir, "ca.crt");

  try {
    await runText(
      [
        OPENSSL,
        "req",
        "-x509",
        "-newkey",
        "rsa:4096",
        "-nodes",
        "-days",
        "3650",
        "-sha256",
        "-subj",
        "/CN=Terrarium OVN CA",
        "-keyout",
        keyPath,
        "-out",
        certPath
      ],
      PREFIX
    );
    return {
      cert: readFileSync(certPath, "utf8"),
      key: readFileSync(keyPath, "utf8")
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function ensureOvnCaMaterial(config: MutableConfig): Promise<void> {
  const existingCert = configString(config, "terrarium_ovn_ca_cert");
  const existingKey = configString(config, "terrarium_ovn_ca_key");
  if (existingCert.trim() && existingKey.trim()) {
    return;
  }

  const material = await createOvnCaMaterial();
  setConfigValue(config, "terrarium_ovn_ca_cert", material.cert);
  setConfigValue(config, "terrarium_ovn_ca_key", material.key);
}

async function converge(skipReconfigure: boolean | undefined): Promise<void> {
  importConfigFileToClusterStore(CONFIG_PATH, PREFIX);
  if (!skipReconfigure) {
    await reconfigureCmd({ applyHardening: false });
  }
}

async function openClusterFirewall(peerCidrs: string[]): Promise<void> {
  warnBroadPeerCidrs(peerCidrs);
  for (const cidr of peerCidrs) {
    for (const rule of CLUSTER_FIREWALL_RULES) {
      await runText([UFW, "allow", "from", cidr, "to", "any", "port", rule.port, "proto", rule.proto], PREFIX);
    }
  }
}

async function closeClusterFirewall(peerCidrs: string[]): Promise<void> {
  for (const cidr of peerCidrs) {
    for (const rule of CLUSTER_FIREWALL_RULES) {
      const result = await runAllowFailure([UFW, "--force", "delete", "allow", "from", cidr, "to", "any", "port", rule.port, "proto", rule.proto]);
      if (result.exitCode !== 0) {
        const details = (result.stderr || result.stdout).trim();
        console.warn(`Could not remove cluster firewall rule for ${cidr} ${rule.port}/${rule.proto}${details ? `: ${details}` : ""}`);
      }
    }
  }
}

function isExactPeerCidr(cidr: string): boolean {
  return exactHostFromPeerCidr(cidr) !== null;
}

function exactHostFromPeerCidr(cidr: string): string | null {
  const [host, prefix] = cidr.split("/");
  if (!host || !prefix) {
    return null;
  }
  if (ipv4ToInt(host) !== null) {
    return prefix === "32" ? host : null;
  }
  if (host.includes(":")) {
    return prefix === "128" ? host : null;
  }
  return null;
}

function warnBroadPeerCidrs(peerCidrs: string[]): void {
  const broad = peerCidrs.filter((cidr) => !isExactPeerCidr(cidr));
  if (broad.length === 0) {
    return;
  }
  console.warn(
    `Warning: broad cluster peer CIDR(s) ${broad.join(", ")} can reach LXD/OVN control-plane ports. Prefer exact /32 or /128 peer addresses unless this subnet is fully trusted.`
  );
}

function mergeClusterPeerCidrs(config: MutableConfig, peerCidrs: string[]): string[] {
  const current = configStringArray(config, "terrarium_cluster_peer_cidrs");
  const added = peerCidrs.filter((cidr) => !current.includes(cidr));
  const next = [...new Set([...current, ...peerCidrs])];
  if (next.length === current.length && next.every((cidr, index) => cidr === current[index])) {
    return [];
  }
  setConfigValue(config, "terrarium_cluster_peer_cidrs", next);
  return added;
}

function saveMergedClusterPeerCidrs(peerCidrs: string[]): boolean {
  if (peerCidrs.length === 0) {
    return false;
  }
  const config = loadMutableConfig();
  if (mergeClusterPeerCidrs(config, peerCidrs).length === 0) {
    return false;
  }
  saveMutableConfig(stringify(config));
  return true;
}

function pendingClusterInvites(config: MutableConfig): PendingClusterInvite[] {
  const value = config[PENDING_INVITES_KEY];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): PendingClusterInvite[] => {
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const record = item as Record<string, unknown>;
    return typeof record.peer_cidr === "string" && typeof record.expires_at === "string"
      ? [{ peer_cidr: record.peer_cidr, expires_at: record.expires_at }]
      : [];
  });
}

function setPendingClusterInvites(config: MutableConfig, invites: PendingClusterInvite[]): void {
  setConfigValue(config, PENDING_INVITES_KEY, invites);
}

function upsertPendingClusterInvites(config: MutableConfig, peerCidrs: string[], expiresAt: string | undefined): string[] {
  if (!expiresAt) {
    return [];
  }

  const currentPeers = configStringArray(config, "terrarium_cluster_peer_cidrs");
  const currentPending = pendingClusterInvites(config);
  const pendingPeerCidrs = new Set(currentPending.map((invite) => invite.peer_cidr));
  const temporaryPeers = peerCidrs.filter((cidr) => isExactPeerCidr(cidr) && (!currentPeers.includes(cidr) || pendingPeerCidrs.has(cidr)));
  if (temporaryPeers.length === 0) {
    return [];
  }

  const nextByPeer = new Map(currentPending.map((invite) => [invite.peer_cidr, invite]));
  for (const peerCidr of temporaryPeers) {
    nextByPeer.set(peerCidr, { peer_cidr: peerCidr, expires_at: expiresAt });
  }
  setPendingClusterInvites(config, [...nextByPeer.values()]);
  return temporaryPeers;
}

function removeClusterPeerCidrs(config: MutableConfig, peerCidrs: string[]): boolean {
  const remove = new Set(peerCidrs);
  const current = configStringArray(config, "terrarium_cluster_peer_cidrs");
  const next = current.filter((cidr) => !remove.has(cidr));
  if (next.length === current.length) {
    return false;
  }
  setConfigValue(config, "terrarium_cluster_peer_cidrs", next);
  return true;
}

function removePendingClusterInvites(config: MutableConfig, peerCidrs: string[]): boolean {
  const remove = new Set(peerCidrs);
  const current = pendingClusterInvites(config);
  const next = current.filter((invite) => !remove.has(invite.peer_cidr));
  if (next.length === current.length) {
    return false;
  }
  setPendingClusterInvites(config, next);
  return true;
}

function saveInvitedPeerCidrs(peerCidrs: string[], expiresAt: string | undefined): { temporaryPeerCidrs: string[]; changed: boolean } {
  if (peerCidrs.length === 0) {
    return { temporaryPeerCidrs: [], changed: false };
  }
  const config = loadMutableConfig();
  const temporaryPeerCidrs = upsertPendingClusterInvites(config, peerCidrs, expiresAt);
  const added = mergeClusterPeerCidrs(config, peerCidrs);
  if (temporaryPeerCidrs.length === 0 && added.length === 0) {
    return { temporaryPeerCidrs: [], changed: false };
  }
  saveMutableConfig(stringify(config));
  return { temporaryPeerCidrs, changed: true };
}

async function discoverPeerCidrsForInvite(member: string): Promise<string[]> {
  const exact = exactPeerCidrForHost(member);
  if (exact) {
    return [exact];
  }

  const result = await runAllowFailure([GETENT, "hosts", member]);
  return result.exitCode === 0 ? peerCidrsFromHostsOutput(result.stdout) : [];
}

async function peerCidrsForInvite(member: string, explicitPeerCidr: string | undefined): Promise<string[]> {
  if (explicitPeerCidr !== undefined) {
    return parsePeerCidrs(explicitPeerCidr);
  }

  const discovered = await discoverPeerCidrsForInvite(member);
  if (discovered.length > 0 || !process.stdin.isTTY || !process.stdout.isTTY) {
    return discovered;
  }

  const answer = await input({
    message: `Private IP or exact CIDR for joining member ${member} (leave blank to skip firewall pre-open):`,
    default: ""
  });
  return parsePeerCidrs(answer);
}

export function secondsUntilInviteCleanup(expiresAt: string, nowMs = Date.now()): number | null {
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) {
    return null;
  }
  return Math.max(60, Math.ceil((expiresMs - nowMs) / 1000));
}

function inviteCleanupUnitName(peerCidrs: string[], expiresAt: string): string {
  const hash = createHash("sha256").update(`${peerCidrs.join(",")}|${expiresAt}`).digest("hex").slice(0, 16);
  return `terrarium-cluster-invite-cleanup-${hash}`;
}

async function scheduleInviteCleanup(peerCidrs: string[], expiresAt: string | undefined): Promise<void> {
  const exactPeerCidrs = peerCidrs.filter(isExactPeerCidr);
  if (!expiresAt || exactPeerCidrs.length === 0) {
    return;
  }

  const delaySeconds = secondsUntilInviteCleanup(expiresAt);
  if (delaySeconds === null) {
    console.warn(`LXD join token expiry ${expiresAt} could not be parsed; temporary firewall cleanup was not scheduled.`);
    return;
  }

  try {
    const result = await runAllowFailure([
      SYSTEMD_RUN,
      `--unit=${inviteCleanupUnitName(exactPeerCidrs, expiresAt)}`,
      "--collect",
      `--on-active=${delaySeconds}s`,
      TERRARIUMCTL,
      "cluster",
      "invite-cleanup",
      "--peer-cidr",
      exactPeerCidrs.join(","),
      "--expires-at",
      expiresAt
    ]);
    if (result.exitCode !== 0) {
      const details = (result.stderr || result.stdout).trim();
      console.warn(`Could not schedule temporary cluster peer cleanup${details ? `: ${details}` : ""}`);
    }
  } catch (error) {
    console.warn(`Could not schedule temporary cluster peer cleanup: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function expiredPendingInvitePeerCidrs(
  config: MutableConfig,
  requestedPeerCidrs: string[],
  cleanupExpiresAt: string | undefined,
  nowMs = Date.now()
): string[] {
  const requested = new Set(requestedPeerCidrs);
  const cleanupExpiryMs = cleanupExpiresAt ? Date.parse(cleanupExpiresAt) : null;

  return pendingClusterInvites(config)
    .filter((invite) => requested.has(invite.peer_cidr))
    .filter((invite) => {
      const inviteExpiryMs = Date.parse(invite.expires_at);
      if (Number.isFinite(cleanupExpiryMs) && Number.isFinite(inviteExpiryMs) && inviteExpiryMs > cleanupExpiryMs) {
        return false;
      }
      return !Number.isFinite(inviteExpiryMs) || inviteExpiryMs <= nowMs;
    })
    .map((invite) => invite.peer_cidr);
}

export function unjoinedExactInvitePeerCidrs(peerCidrs: string[], memberAddresses: string[]): string[] {
  const members = new Set(memberAddresses.map(endpointHost));
  return peerCidrs.filter((cidr) => {
    const host = exactHostFromPeerCidr(cidr);
    return host !== null && !members.has(host);
  });
}

async function commandSucceeds(cmd: string[]): Promise<boolean> {
  return (await runAllowFailure(cmd)).exitCode === 0;
}

async function discoverMemberName(): Promise<string> {
  const hostname = (await runText([HOSTNAME, "-s"], PREFIX)).trim();
  if (!hostname) {
    throw new Error("could not discover local hostname; pass --member explicitly");
  }
  return hostname;
}

function routeSourceFromRouteGetJson(value: string): string | undefined {
  const routes = JSON.parse(value || "[]") as Array<{ prefsrc?: unknown; src?: unknown }>;
  const first = routes[0];
  if (!first) {
    return undefined;
  }
  return typeof first.prefsrc === "string" ? first.prefsrc : typeof first.src === "string" ? first.src : undefined;
}

async function discoverClusterNetwork(targetHost?: string): Promise<DiscoveredClusterNetwork> {
  const addressResult = await runAllowFailure([IP, "-j", "addr", "show", "scope", "global"]);
  const routeGetResult = targetHost ? await runAllowFailure([IP, "-j", "route", "get", targetHost]) : undefined;

  const candidates = addressResult.exitCode === 0 ? addressCandidatesFromIpJson(addressResult.stdout) : [];
  const routeSource = routeGetResult?.exitCode === 0 ? routeSourceFromRouteGetJson(routeGetResult.stdout) : undefined;
  const selected = selectClusterAddressCandidate(candidates, routeSource);

  if (selected) {
    const peerCidr = selected.private ? bestPeerCidrForAddress(selected) : undefined;
    return {
      address: selected.address,
      peerCidr,
      ifname: selected.ifname
    };
  }

  if (routeSource) {
    return {
      address: routeSource,
      peerCidr: exactPeerCidrForHost(routeSource) ?? undefined
    };
  }

  throw new Error("could not discover a reachable cluster address; pass --address explicitly");
}

function singleAddressFromJoinToken(token: string): string | undefined {
  const address = decodeLxdJoinToken(token).addresses[0];
  return address ? endpointHost(address) : undefined;
}

async function discoverClusterMemberAddresses(): Promise<string[]> {
  const result = await runAllowFailure([LXC, "cluster", "list", "--format", "json"]);
  return result.exitCode === 0 ? clusterMemberAddressesFromJson(result.stdout) : [];
}

async function discoverClusterMembers(options: { onlineOnly?: boolean } = {}): Promise<ClusterMember[]> {
  const result = await runText([LXC, "cluster", "list", "--format", "json"], PREFIX);
  return clusterMembersFromJson(result, options);
}

async function listInstanceNamesOnMember(member: string): Promise<string[]> {
  return (await listInstancesOnMember(member)).map((instance) => instance.name);
}

async function listInstancesOnMember(member: string): Promise<ClusterWorkload[]> {
  const result = await runText([LXC, "query", "/1.0/instances?recursion=1"], PREFIX);
  return instancesFromLxcListJson(result).filter((instance) => instance.location === member);
}

async function inspectWorkload(name: string): Promise<ClusterWorkload> {
  const result = await runText([LXC, "query", `/1.0/instances/${encodeURIComponent(name)}`], PREFIX);
  const instance = JSON.parse(result || "{}") as { name?: unknown; status?: unknown; location?: unknown };
  const workload: ClusterWorkload = { name };
  if (typeof instance.name === "string" && instance.name.length > 0) {
    workload.name = instance.name;
  }
  if (typeof instance.status === "string") {
    workload.status = instance.status;
  }
  if (typeof instance.location === "string") {
    workload.location = instance.location;
  }
  return workload;
}

async function reconcileAfterMemberRemove(removedAddress: string | undefined, skipReconfigure: boolean | undefined): Promise<void> {
  const config = loadMutableConfig();
  const network = configString(config, "terrarium_lxd_network_name", DEFAULT_OVN_NETWORK);
  const parent = configString(config, "terrarium_lxd_network_parent", DEFAULT_OVN_PARENT);
  const discoveredAddresses = await discoverClusterMemberAddresses();
  const removedExactCidr = removedAddress ? exactPeerCidrForHost(removedAddress) : null;
  const existingCentralAddresses = configStringArray(config, "terrarium_ovn_central_addresses").filter((address) => address !== removedAddress);
  const centralAddresses =
    discoveredAddresses.length > 0 ? selectOvnCentralAddresses(discoveredAddresses) : selectOvnCentralAddresses(existingCentralAddresses);
  const discoveredPeerCidrs = discoveredAddresses
    .map((address) => exactPeerCidrForHost(address))
    .filter((cidr): cidr is string => cidr !== null);
  const pendingPeerCidrs = pendingClusterInvites(config).map((invite) => invite.peer_cidr);
  const peerCidrs =
    discoveredPeerCidrs.length > 0
      ? [...new Set([...discoveredPeerCidrs, ...pendingPeerCidrs])]
      : configStringArray(config, "terrarium_cluster_peer_cidrs").filter((cidr) => cidr !== removedExactCidr);

  applyClusterConfig(config, { network, parent, centralAddresses, peerCidrs });
  saveMutableConfig(stringify(config));
  await converge(skipReconfigure);
}

async function memberMemoryLoad(member: string): Promise<{ used?: number; total?: number }> {
  const result = await runAllowFailure([LXC, "query", `/1.0/resources?target=${encodeURIComponent(member)}`]);
  if (result.exitCode !== 0) {
    return {};
  }
  try {
    return memoryLoadFromResourcesJson(result.stdout);
  } catch {
    return {};
  }
}

async function buildPlacementCandidates(sourceMember: string): Promise<ClusterMemberPlacement[]> {
  const members = await discoverClusterMembers();
  const targets = members.map((member) => member.name).filter((name): name is string => Boolean(name) && name !== sourceMember);
  const candidates: ClusterMemberPlacement[] = [];

  for (const member of targets) {
    const [workloads, memory] = await Promise.all([listInstancesOnMember(member), memberMemoryLoad(member)]);
    candidates.push({
      member,
      workloadCount: workloads.length,
      plannedWorkloadCount: workloads.length,
      memoryUsed: memory.used,
      memoryTotal: memory.total
    });
  }

  return candidates;
}

async function buildRemovalMovePlan(
  sourceMember: string,
  workloads: ClusterWorkload[],
  requestedTarget: string | undefined
): Promise<ClusterMovePlanItem[]> {
  if (requestedTarget?.trim()) {
    const target = requestedTarget.trim();
    return workloads.map((workload) => ({ workload, target }));
  }

  return buildWorkloadMovePlan(workloads, await buildPlacementCandidates(sourceMember));
}

function printMovePlan(plan: ClusterMovePlanItem[]): void {
  console.log("Workload move plan:");
  for (const item of plan) {
    console.log(`  ${item.workload.name} -> ${item.target}`);
  }
}

async function assertNoLocalInstancesBeforeJoin(): Promise<void> {
  const result = await runAllowFailure([LXC, "list", "--format", "csv", "-c", "n"]);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`failed to inspect local LXD instances before cluster join${stderr ? `: ${stderr}` : ""}`);
  }

  const instances = nonEmptyLines(result.stdout);
  if (instances.length > 0) {
    throw new Error(`cluster join requires an empty local LXD server; remove or migrate these instances first: ${instances.join(", ")}`);
  }
}

async function removeProfileDeviceIfPresent(profile: string, device: string): Promise<void> {
  await runAllowFailure([LXC, "profile", "device", "remove", profile, device]);
}

async function deleteProfileIfPresent(profile: string): Promise<void> {
  if (await commandSucceeds([LXC, "profile", "show", profile])) {
    await runText([LXC, "profile", "delete", profile], PREFIX);
  }
}

async function deleteNetworkIfPresent(network: string): Promise<void> {
  if (await commandSucceeds([LXC, "network", "show", network])) {
    await runText([LXC, "network", "delete", network], PREFIX);
  }
}

async function deleteStoragePoolIfPresent(pool: string): Promise<void> {
  if (await commandSucceeds([LXC, "storage", "show", pool])) {
    await runText([LXC, "storage", "delete", pool], PREFIX);
  }
}

async function recreateImportedZpoolForClusterJoin(storage: JoinStorageConfig): Promise<void> {
  if (!storage.source) {
    return;
  }

  await runAllowFailure([ZPOOL, "destroy", "-f", storage.pool]);

  if (storage.mode === "file") {
    await runText([MKDIR, "-p", dirname(storage.source)], PREFIX);
    await runAllowFailure([RM, "-f", storage.source]);
    await runText([TRUNCATE, "-s", storage.size, storage.source], PREFIX);
  }

  await runText(
    [
      ZPOOL,
      "create",
      "-f",
      "-o",
      "ashift=12",
      "-O",
      "compression=zstd",
      "-O",
      "atime=off",
      "-O",
      "xattr=sa",
      "-O",
      "normalization=formD",
      "-m",
      "none",
      storage.pool,
      storage.source
    ],
    PREFIX
  );
}

async function prepareLocalLxdForClusterJoin(storage: JoinStorageConfig): Promise<void> {
  await assertNoLocalInstancesBeforeJoin();

  // A Terrarium-installed join node has local LXD config already. LXD cluster
  // join rejects that standalone pool because source is member-specific, so
  // clear only Terrarium-managed empty LXD entities before importing cluster
  // state from the seed. Recreate the underlying zpool afterwards and leave it
  // imported; file-backed pools are not discoverable by plain `zpool import`.
  for (const profile of ["default", "terrarium", "strict", "kvm"]) {
    await removeProfileDeviceIfPresent(profile, "root");
    await removeProfileDeviceIfPresent(profile, "eth0");
  }

  for (const profile of ["terrarium", "strict", "kvm"]) {
    await deleteProfileIfPresent(profile);
  }

  await deleteNetworkIfPresent(DEFAULT_OVN_NETWORK);
  await deleteNetworkIfPresent(DEFAULT_OVN_PARENT);
  await deleteStoragePoolIfPresent(storage.pool);
  await recreateImportedZpoolForClusterJoin(storage);
}

export async function clusterStatusCmd(): Promise<void> {
  const cluster = await runText([LXC, "cluster", "list"], PREFIX);
  const networkName = configString(loadMutableConfig(), "terrarium_lxd_network_name", DEFAULT_OVN_NETWORK);
  const network = await runText([LXC, "network", "show", networkName], PREFIX).catch(() => "");
  console.log(cluster.trimEnd());
  if (network.trim()) {
    console.log("");
    console.log(network.trimEnd());
  }
}

export async function clusterInitCmd(options: ClusterInitOptions): Promise<void> {
  const discovered = options.address ? undefined : await discoverClusterNetwork();
  const member = options.member || (await discoverMemberName());
  const address = options.address ?? discovered?.address;
  if (!address) {
    throw new Error("could not discover a reachable cluster address; pass --address explicitly");
  }

  const endpoint = normalizeClusterEndpoint(address);
  const endpointAddress = endpointHost(endpoint);
  const network = options.network || DEFAULT_OVN_NETWORK;
  const parent = options.parent || DEFAULT_OVN_PARENT;
  const centralAddresses = options.centralAddresses === undefined ? [endpointAddress] : parseCsv(options.centralAddresses);
  const defaultPeerCidr = discovered?.peerCidr ?? exactPeerCidrForHost(endpointAddress) ?? undefined;
  const peerCidrs =
    options.peerCidr === undefined ? (defaultPeerCidr ? [defaultPeerCidr] : []) : parsePeerCidrs(options.peerCidr);

  await openClusterFirewall(peerCidrs);
  await runText([LXC, "config", "set", "core.https_address", endpoint], PREFIX);
  await runText([LXC, "cluster", "enable", member], PREFIX);

  const config = loadMutableConfig();
  applyClusterConfig(config, { network, parent, centralAddresses, peerCidrs });
  if (centralAddresses.length > 0) {
    await ensureOvnCaMaterial(config);
  }
  saveMutableConfig(stringify(config));
  await converge(options.skipReconfigure);

  console.log(success(`Initialized LXD cluster member ${member} at ${endpoint}`));
  if (options.address === undefined) {
    console.log(success(`Auto-discovered cluster address ${endpoint}${discovered?.ifname ? ` on ${discovered.ifname}` : ""}`));
  }
  if (options.peerCidr === undefined && peerCidrs.length === 0) {
    console.warn("Terrarium did not auto-open cluster peer firewall rules because no exact peer address was discovered. Pass --peer-cidr <peer-ip>/32 for public-only clusters.");
  }
}

async function mintClusterToken(member: string): Promise<string> {
  const normalized = member.trim();
  if (!normalized) {
    throw new Error("cluster token requires a member name");
  }
  const token = await runText([LXC, "cluster", "add", normalized], PREFIX);
  return extractLxdJoinToken(token);
}

export async function clusterTokenCmd(member: string): Promise<void> {
  console.log(await mintClusterToken(member));
}

export async function clusterInviteCmd(member: string, options: ClusterInviteOptions = {}): Promise<void> {
  const normalized = member.trim();
  if (!normalized) {
    throw new Error("cluster invite requires a member name");
  }

  const token = await mintClusterToken(normalized);
  const tokenExpiry = decodeLxdJoinToken(token).expiresAt;
  const peerCidrs = await peerCidrsForInvite(normalized, options.peerCidr);
  if (peerCidrs.length > 0) {
    await openClusterFirewall(peerCidrs);
    const { temporaryPeerCidrs, changed } = saveInvitedPeerCidrs(peerCidrs, tokenExpiry);
    if (temporaryPeerCidrs.length > 0) {
      await scheduleInviteCleanup(temporaryPeerCidrs, tokenExpiry);
    }
    if (changed) {
      console.log(success(`Allowed cluster peer ${peerCidrs.join(", ")}`));
    }
    if (!tokenExpiry && peerCidrs.some(isExactPeerCidr)) {
      console.warn("LXD join token did not include an expiry; temporary cluster peer cleanup was not scheduled.");
    }
  } else {
    console.warn(
      `Terrarium could not resolve ${normalized} to an IP address, so this member's firewall was not pre-opened for the joining node. If join cannot reach this member, rerun with --peer-cidr <joining-node-ip>/32.`
    );
  }

  console.log("Run this on the new node:");
  console.log(`terrariumctl cluster join --token ${shellEscape(token)}`);
}

export async function clusterInviteCleanupCmd(options: ClusterInviteCleanupOptions): Promise<void> {
  const peerCidrs = parsePeerCidrs(options.peerCidr);
  if (peerCidrs.length === 0) {
    throw new Error("cluster invite-cleanup requires --peer-cidr");
  }
  if (options.expiresAt) {
    const expiresMs = Date.parse(options.expiresAt);
    if (Number.isFinite(expiresMs) && Date.now() < expiresMs) {
      console.log(`Invite cleanup for ${peerCidrs.join(", ")} is not due yet.`);
      return;
    }
  }

  const config = loadMutableConfig();
  const expiredPeerCidrs = expiredPendingInvitePeerCidrs(config, peerCidrs, options.expiresAt);
  if (expiredPeerCidrs.length === 0) {
    console.log(`No expired pending invite peer rules found for ${peerCidrs.join(", ")}.`);
    return;
  }

  let members: ClusterMember[];
  try {
    members = await discoverClusterMembers({ onlineOnly: false });
  } catch (error) {
    console.warn(`Could not inspect LXD cluster membership; keeping pending peer rules: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const memberAddresses = members.map((member) => member.address);
  const removablePeerCidrs = unjoinedExactInvitePeerCidrs(expiredPeerCidrs, memberAddresses);
  const joinedPeerCidrs = expiredPeerCidrs.filter((cidr) => !removablePeerCidrs.includes(cidr));
  const changedPending = removePendingClusterInvites(config, expiredPeerCidrs);
  const changedPeers = removeClusterPeerCidrs(config, removablePeerCidrs);

  if (changedPending || changedPeers) {
    saveMutableConfig(stringify(config));
  }
  if (removablePeerCidrs.length > 0) {
    await closeClusterFirewall(removablePeerCidrs);
    console.log(success(`Removed expired cluster invite peer ${removablePeerCidrs.join(", ")}`));
  }
  if (joinedPeerCidrs.length > 0) {
    console.log(success(`Kept joined cluster peer ${joinedPeerCidrs.join(", ")}`));
  }
}

export async function clusterJoinCmd(options: ClusterJoinOptions): Promise<void> {
  if (!options.token) {
    throw new Error("--token is required");
  }

  if (!options.yes) {
    const approved = await confirm({
      message: "Joining an LXD cluster replaces this node's local LXD database. Continue?",
      default: false
    });
    if (!approved) {
      throw new Error("operation cancelled");
    }
  }

  const storagePool = options.storagePool || DEFAULT_STORAGE_POOL;
  const storage = resolveJoinStorageConfig(loadMutableConfig(), storagePool);
  const tokenPeerHost = singleAddressFromJoinToken(options.token);
  const discovered = options.address ? undefined : await discoverClusterNetwork(tokenPeerHost);
  const address = options.address ?? discovered?.address;
  if (!address) {
    throw new Error("could not discover this node's cluster address; pass --address explicitly");
  }
  const preseed = buildJoinPreseed({
    serverAddress: normalizeClusterEndpoint(address),
    clusterToken: options.token,
    storagePool
  });
  const peerCidrs = options.peerCidr === undefined ? peerCidrsFromJoinToken(options.token) : parsePeerCidrs(options.peerCidr);
  await openClusterFirewall(peerCidrs);
  await prepareLocalLxdForClusterJoin(storage);
  await runText([LXD, "init", "--preseed"], PREFIX, { stdin: preseed });

  if (!options.skipExport && !exportClusterStoreToConfigFile(CONFIG_PATH, PREFIX)) {
    throw new Error("joined cluster, but Terrarium config was not found in the LXD dqlite store");
  }
  if (!options.skipExport) {
    const localPeerCidr = exactPeerCidrForHost(endpointHost(normalizeClusterEndpoint(address)));
    saveMergedClusterPeerCidrs([...peerCidrs, localPeerCidr].filter((cidr): cidr is string => cidr !== null));
  }
  if (!options.skipReconfigure) {
    await reconfigureCmd({ applyHardening: false });
  }

  console.log(success("Joined the LXD cluster"));
}

async function confirmClusterMemberAction(member: string, action: "evacuate" | "restore", options: ClusterMemberActionOptions): Promise<void> {
  if (options.yes) {
    return;
  }
  const approved = await confirm({
    message: `${action === "evacuate" ? "Evacuate" : "Restore"} LXD cluster member ${member}?`,
    default: false
  });
  if (!approved) {
    throw new Error("operation cancelled");
  }
}

export async function clusterEvacuateCmd(member: string, options: ClusterMemberActionOptions = {}): Promise<void> {
  const normalized = member.trim();
  if (!normalized) {
    throw new Error("cluster evacuate requires a member name");
  }
  await confirmClusterMemberAction(normalized, "evacuate", options);
  await runText([LXC, "cluster", "evacuate", normalized], PREFIX, { stdin: "yes\n" });
  console.log(success(`Evacuated LXD cluster member ${normalized}`));
}

export async function clusterRestoreCmd(member: string, options: ClusterMemberActionOptions = {}): Promise<void> {
  const normalized = member.trim();
  if (!normalized) {
    throw new Error("cluster restore requires a member name");
  }
  await confirmClusterMemberAction(normalized, "restore", options);
  await runText([LXC, "cluster", "restore", normalized], PREFIX, { stdin: "yes\n" });
  console.log(success(`Restored LXD cluster member ${normalized}`));
}

export async function clusterMoveCmd(workload: string, targetMember: string): Promise<void> {
  const normalizedWorkload = workload.trim();
  const normalizedTarget = targetMember.trim();
  if (!normalizedWorkload || !normalizedTarget) {
    throw new Error("cluster move requires a workload name and target member");
  }
  await moveWorkload(await inspectWorkload(normalizedWorkload), normalizedTarget);
  console.log(success(`Moved ${normalizedWorkload} to ${normalizedTarget}`));
}

async function moveWorkload(workload: ClusterWorkload, targetMember: string): Promise<void> {
  const wasRunning = workload.status?.toLowerCase() === "running";
  if (wasRunning) {
    console.log(`Stopping ${workload.name} before moving it to ${targetMember}`);
    const stop = await runAllowFailure([TIMEOUT, "90s", LXC, "stop", workload.name, "--timeout", "60"]);
    if (stop.exitCode !== 0) {
      console.warn(`Graceful stop failed for ${workload.name}; forcing stop before move`);
      await runText([TIMEOUT, "60s", LXC, "stop", workload.name, "--force"], PREFIX);
    }
  }

  console.log(`Moving ${workload.name} to ${targetMember}`);
  await runText([LXC, "move", workload.name, workload.name, "--target", targetMember], PREFIX);

  if (wasRunning) {
    console.log(`Starting ${workload.name} on ${targetMember}`);
    await runText([LXC, "start", workload.name], PREFIX);
  }
}

export async function clusterRemoveCmd(member: string, options: ClusterRemoveOptions): Promise<void> {
  const normalized = member.trim();
  if (!normalized) {
    throw new Error("cluster remove requires a member name");
  }

  const members = await discoverClusterMembers({ onlineOnly: false }).catch(() => []);
  const removedAddress = members.find((item) => item.name === normalized)?.address;

  if (options.force) {
    if (!options.yes) {
      const approved = await confirm({
        message: `Force-remove ${normalized}? Workloads that only existed on that member are not recovered automatically.`,
        default: false
      });
      if (!approved) {
        throw new Error("operation cancelled");
      }
    }
    await runText([LXC, "cluster", "remove", normalized, "--force"], PREFIX);
    await reconcileAfterMemberRemove(removedAddress, options.skipReconfigure);
    console.log(success(`Force-removed LXD cluster member ${normalized}`));
    return;
  }

  const workloads = await listInstancesOnMember(normalized);
  if (workloads.length > 0) {
    let shouldMove = Boolean(options.move);
    if (!shouldMove) {
      shouldMove = await confirm({
        message: `${normalized} still has ${workloads.length} workload(s): ${workloads.map((workload) => workload.name).join(", ")}. Move them before removing this member?`,
        default: true
      });
    }
    if (!shouldMove) {
      throw new Error(`cluster member ${normalized} still has workloads; move them or rerun with --move`);
    }

    const plan = await buildRemovalMovePlan(normalized, workloads, options.target);
    printMovePlan(plan);
    if (!options.yes) {
      const approved = await confirm({
        message: "Apply this workload move plan?",
        default: true
      });
      if (!approved) {
        throw new Error("operation cancelled");
      }
    }

    for (const item of plan) {
      await moveWorkload(item.workload, item.target);
    }

    const remaining = await listInstanceNamesOnMember(normalized);
    if (remaining.length > 0) {
      throw new Error(`cluster member ${normalized} still has workloads after move: ${remaining.join(", ")}`);
    }
  }

  if (!options.yes) {
    const approved = await confirm({
      message: `Remove LXD cluster member ${normalized}? The removed host should be rebuilt before reuse.`,
      default: false
    });
    if (!approved) {
      throw new Error("operation cancelled");
    }
  }

  await runText([LXC, "cluster", "remove", normalized], PREFIX);
  await reconcileAfterMemberRemove(removedAddress, options.skipReconfigure);
  console.log(success(`Removed LXD cluster member ${normalized}`));
}

export async function clusterOvnConfigureCmd(options: ClusterOvnOptions): Promise<void> {
  const network = options.network || DEFAULT_OVN_NETWORK;
  const parent = options.parent || DEFAULT_OVN_PARENT;
  const config = loadMutableConfig();
  const discoveredMemberAddresses =
    options.centralAddresses === undefined || options.peerCidr === undefined ? await discoverClusterMemberAddresses() : [];
  const existingCentralAddresses = configStringArray(config, "terrarium_ovn_central_addresses");
  const discoveredCentralAddresses = selectOvnCentralAddresses(discoveredMemberAddresses);
  const usedDiscoveredCentralAddresses =
    options.centralAddresses === undefined && discoveredCentralAddresses.length > existingCentralAddresses.length;
  const centralAddresses =
    options.centralAddresses === undefined
      ? usedDiscoveredCentralAddresses
        ? discoveredCentralAddresses
        : existingCentralAddresses
      : parseCsv(options.centralAddresses);
  const existingPeerCidrs = configStringArray(config, "terrarium_cluster_peer_cidrs");
  const discoveredPeerCidrs = discoveredMemberAddresses
    .map((address) => exactPeerCidrForHost(address))
    .filter((cidr): cidr is string => cidr !== null);
  const pendingPeerCidrs = pendingClusterInvites(config).map((invite) => invite.peer_cidr);
  const peerCidrs =
    options.peerCidr === undefined
      ? discoveredPeerCidrs.length > 0
        ? [...new Set([...discoveredPeerCidrs, ...pendingPeerCidrs])]
        : existingPeerCidrs
      : parsePeerCidrs(options.peerCidr);
  warnBroadPeerCidrs(peerCidrs);

  if (centralAddresses.length > 0 && centralAddresses.length % 2 === 0) {
    throw new Error("--central-addresses should contain an odd number of OVN central members");
  }

  applyClusterConfig(config, { network, parent, centralAddresses, peerCidrs });
  if (centralAddresses.length > 0) {
    await ensureOvnCaMaterial(config);
  }
  saveMutableConfig(stringify(config));
  await converge(options.skipReconfigure);

  console.log(success(`Configured Terrarium OVN network ${network}`));
  if (usedDiscoveredCentralAddresses) {
    console.log(success(`Auto-discovered OVN central members: ${centralAddresses.join(", ")}`));
  }
  if (centralAddresses.length > 0) {
    console.log(success(`OVN central northbound: ${ovnDbEndpoints(centralAddresses, "6641")}`));
  }
}
