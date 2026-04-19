import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { IntegrationCliOptions, IntegrationConfig } from "./types";

function loadDotEnvFile(): void {
  const explicitPath = process.env.TERRARIUM_INTEGRATION_ENV_FILE?.trim();
  const defaultPath = resolve(process.cwd(), "tests/integration/.env");
  const envPath = explicitPath ? resolve(explicitPath) : defaultPath;
  if (!existsSync(envPath)) {
    return;
  }

  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1);
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
  }
}

loadDotEnvFile();

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
}

function computeSlug(): string {
  const runId = optionalEnv("GITHUB_RUN_ID");
  const sha = optionalEnv("GITHUB_SHA").slice(0, 7);
  const base = runId ? `gha-${runId}-${sha || "local"}` : `local-${Date.now().toString(36)}-${sha || "dev"}`;
  return slugify(base);
}

function ensureTempKey(pathHint: string, content: string): string {
  const target = join(tmpdir(), pathHint);
  writeFileSync(target, `${content.trim()}\n`, { encoding: "utf8", mode: 0o600 });
  return target;
}

/**
 * Normalizes SSH key material passed through environment variables.
 *
 * This lets local `.env` files carry a private key as a single line with
 * escaped newlines, for example `-----BEGIN...-----\\n...\\n-----END...-----`.
 */
function normalizeKeyContent(content: string): string {
  const trimmed = content.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.includes("\\n") ? trimmed.replace(/\\n/g, "\n") : trimmed;
}

/** Loads the harness configuration from CLI options plus environment secrets. */
export function loadIntegrationConfig(options: IntegrationCliOptions): IntegrationConfig {
  const repoRoot = resolve(process.cwd());
  const slug = optionalEnv("TERRARIUM_INTEGRATION_SLUG", computeSlug());
  const outputDir = resolve(optionalEnv("TERRARIUM_INTEGRATION_OUTPUT_DIR", join(repoRoot, "tests/integration/output", slug)));
  mkdirSync(outputDir, { recursive: true });

  const privateKeyPath = optionalEnv("HCLOUD_SSH_PRIVATE_KEY_FILE");
  const publicKeyPath = optionalEnv("HCLOUD_SSH_PUBLIC_KEY_FILE");
  const publicKey =
    publicKeyPath && existsSync(publicKeyPath)
      ? publicKeyPath
      : ensureTempKey(`terrarium-${slug}-id_ed25519.pub`, normalizeKeyContent(requiredEnv("HCLOUD_SSH_PUBLIC_KEY")));

  const normalizedPrivateKey =
    privateKeyPath && existsSync(privateKeyPath)
      ? privateKeyPath
      : ensureTempKey(`terrarium-${slug}-id_ed25519`, normalizeKeyContent(requiredEnv("HCLOUD_SSH_PRIVATE_KEY")));

  return {
    suite: options.suite,
    only: new Set(options.only),
    keepOnFailure: options.keepOnFailure || optionalEnv("KEEP_ON_FAILURE") === "true",
    reuseInfra: options.reuseInfra || optionalEnv("REUSE_INFRA") === "true",
    releasePreflight: options.releasePreflight || optionalEnv("RELEASE_PREFLIGHT") === "true",
    slug,
    repoRoot,
    outputDir,
    hcloudToken: requiredEnv("HCLOUD_TOKEN"),
    hcloudLocation: requiredEnv("HCLOUD_LOCATION"),
    hcloudServerType: requiredEnv("HCLOUD_SERVER_TYPE").toLowerCase(),
    hcloudBinaryTarget: optionalEnv("HCLOUD_BINARY_TARGET", "x64"),
    hcloudVolumeSizeGb: Number(optionalEnv("HCLOUD_VOLUME_SIZE_GB", "40")),
    sshPrivateKey: normalizedPrivateKey,
    sshPublicKey: publicKey,
    sshUser: optionalEnv("HCLOUD_SSH_USER", "root"),
    duckdnsDomain: requiredEnv("DUCKDNS_DOMAIN"),
    duckdnsToken: requiredEnv("DUCKDNS_TOKEN"),
    zitadelCloudIssuer: requiredEnv("ZITADEL_CLOUD_ISSUER"),
    zitadelCloudPat: requiredEnv("ZITADEL_CLOUD_PAT"),
    zitadelCloudOrgId: optionalEnv("ZITADEL_CLOUD_ORG_ID"),
    s3Endpoint: requiredEnv("S3_ENDPOINT"),
    s3Bucket: requiredEnv("S3_BUCKET"),
    s3Region: requiredEnv("S3_REGION"),
    s3AccessKey: requiredEnv("S3_ACCESS_KEY"),
    s3SecretKey: requiredEnv("S3_SECRET_KEY"),
    cifsAddress: requiredEnv("CIFS_ADDRESS"),
    cifsUsername: requiredEnv("CIFS_USERNAME"),
    cifsPassword: requiredEnv("CIFS_PASSWORD"),
    cifsHostPathBase: requiredEnv("CIFS_HOST_PATH_BASE")
  };
}
