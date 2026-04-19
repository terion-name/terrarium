import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./lib/process";
import { IntegrationLogger } from "./lib/logger";
import { loadIntegrationConfig } from "./config";
import type {
  DomainBundle,
  IntegrationCliOptions,
  IntegrationConfig,
  ManagedHost,
  ScenarioResult,
  ServerRecord,
  VolumeRecord
} from "./types";
import { HetznerCloudProvider } from "./provider/hetzner";
import { DuckDnsProvider } from "./provider/duckdns";
import { ZitadelCloudProvider } from "./provider/zitadel-cloud";
import { S3Provider } from "./provider/s3";
import { CifsProvider } from "./provider/cifs";
import { SshHost } from "./remote/ssh";

type CleanupTask = () => Promise<void>;

/** Global per-run context shared by all integration scenarios. */
export class IntegrationContext {
  readonly config: IntegrationConfig;
  readonly logger: IntegrationLogger;
  readonly hetzner: HetznerCloudProvider;
  readonly duckdns: DuckDnsProvider;
  readonly zitadelCloud: ZitadelCloudProvider;
  readonly s3: S3Provider;
  readonly cifs: CifsProvider;
  readonly results: ScenarioResult[] = [];
  readonly localArtifactsDir: string;
  readonly linuxBundleDir: string;
  readonly linuxBinaryPath: string;
  readonly sourceArchivePath: string;
  private readonly cleanupTasks: CleanupTask[] = [];
  private readonly sshKeyIdByName = new Map<string, number>();

  constructor(options: IntegrationCliOptions) {
    this.config = loadIntegrationConfig(options);
    this.localArtifactsDir = join(this.config.outputDir, "artifacts");
    this.linuxBundleDir = join(this.config.outputDir, "bundle");
    this.linuxBinaryPath = join(this.linuxBundleDir, "dist", "terrariumctl");
    this.sourceArchivePath = join(this.linuxBundleDir, "terrarium-src.tar.gz");
    mkdirSync(this.localArtifactsDir, { recursive: true });
    mkdirSync(join(this.linuxBundleDir, "dist"), { recursive: true });

    this.logger = new IntegrationLogger(join(this.config.outputDir, "integration.log"));
    this.hetzner = new HetznerCloudProvider(this.config, this.logger.child("hetzner"));
    this.duckdns = new DuckDnsProvider(this.config, this.logger.child("duckdns"));
    this.zitadelCloud = new ZitadelCloudProvider(this.config, this.logger.child("zitadel-cloud"));
    this.s3 = new S3Provider(this.config, this.logger.child("s3"));
    this.cifs = new CifsProvider(this.config, this.logger.child("cifs"));
  }

  async buildLinuxBundle(): Promise<void> {
    this.logger.info("building linux terrariumctl bundle for remote installation");
    await run(
      [
        "bun",
        "build",
        "--compile",
        `--target=bun-linux-${this.config.hcloudBinaryTarget}`,
        "scripts/terrariumctl.ts",
        "--outfile",
        this.linuxBinaryPath
      ],
      { cwd: this.config.repoRoot }
    );

    await run(
      [
        "tar",
        "-czf",
        this.sourceArchivePath,
        "--exclude=.git",
        "--exclude=node_modules",
        "--exclude=dist",
        "--exclude=tests/integration/output",
        "."
      ],
      { cwd: this.config.repoRoot }
    );
  }

  domainBundle(prefix: string): DomainBundle {
    return {
      manage: this.duckdns.serviceHost(`${prefix}-manage`, this.config.slug),
      proxy: this.duckdns.serviceHost(`${prefix}-proxy`, this.config.slug),
      lxd: this.duckdns.serviceHost(`${prefix}-lxd`, this.config.slug),
      auth: this.duckdns.serviceHost(`${prefix}-auth`, this.config.slug)
    };
  }

  async registerHetznerKey(name: string): Promise<number> {
    const publicKey = readFileSync(this.config.sshPublicKey, "utf8");
    const id = await this.hetzner.createSshKey(name, publicKey);
    this.sshKeyIdByName.set(name, id);
    this.registerCleanup(async () => {
      await this.hetzner.deleteSshKey(id);
    });
    return id;
  }

  host(label: string, server: ServerRecord, domains: DomainBundle, volume?: VolumeRecord): ManagedHost {
    return { label, server, domains, volume };
  }

  ssh(host: ManagedHost): SshHost {
    return new SshHost(host.server.ipv4, this.config.sshUser, this.config.sshPrivateKey, this.logger.child(host.label));
  }

  registerCleanup(task: CleanupTask): void {
    this.cleanupTasks.unshift(task);
  }

  async runCleanup(): Promise<void> {
    const failures: string[] = [];
    for (const task of this.cleanupTasks) {
      try {
        await task();
      } catch (error) {
        failures.push(String(error));
      }
    }
    if (failures.length > 0) {
      this.logger.warn(`cleanup completed with ${failures.length} failures:\n${failures.join("\n")}`);
    }
  }

  async withScenario(name: string, runScenario: () => Promise<void>): Promise<void> {
    if (this.config.only.size > 0 && !this.config.only.has(name)) {
      this.logger.info(`skip scenario ${name} because it is not in --only`);
      return;
    }

    const result: ScenarioResult = {
      name,
      startedAt: new Date().toISOString(),
      finishedAt: "",
      success: false,
      notes: []
    };
    this.results.push(result);
    try {
      await runScenario();
      result.success = true;
    } finally {
      result.finishedAt = new Date().toISOString();
      writeFileSync(join(this.config.outputDir, "results.json"), `${JSON.stringify(this.results, null, 2)}\n`, "utf8");
    }
  }
}

/** Creates the integration context from CLI options. */
export function createContext(options: IntegrationCliOptions): IntegrationContext {
  return new IntegrationContext(options);
}
