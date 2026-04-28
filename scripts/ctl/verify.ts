import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeS3Endpoint, runAllowFailure } from "../lib/common";

/** Input required to verify a writable S3-compatible backup target. */
export type S3VerificationOptions = {
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  accessKey: string;
  secretKey: string;
};

/** Input required to verify an external OIDC issuer and confidential client. */
export type OidcVerificationOptions = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  lxdClientId?: string;
  lxdClientSecret?: string;
  manageDomain: string;
  lxdDomain: string;
};

/**
 * Ensures the AWS CLI is available before Terrarium performs S3 verification.
 *
 * Terrarium uses the CLI here because it already depends on it for backup
 * export/restore workflows and it gives us a provider-neutral test path.
 *
 * Noble no longer ships a usable `awscli` apt package, so this follows the
 * AWS-documented Linux installer path directly instead of probing dead distro
 * packages first.
 */
async function ensureAwsCli(): Promise<void> {
  const check = await runAllowFailure(["bash", "-lc", "command -v aws >/dev/null 2>&1"]);
  if (check.exitCode === 0) {
    return;
  }

  const fallbackArch = ({ x64: "x86_64", x86_64: "x86_64", amd64: "x86_64", aarch64: "aarch64", arm64: "aarch64" } as Record<string, string>)[
    process.arch
  ] ?? process.arch;
  const tempDir = mkdtempSync(join(tmpdir(), "terrarium-awscli-install-"));
  const archivePath = join(tempDir, `awscliv2-${fallbackArch}.zip`);

  try {
    const update = await runAllowFailure(["apt-get", "update", "-y"]);
    if (update.exitCode !== 0) {
      throw new Error(update.stderr.trim() || update.stdout.trim() || "apt-get update failed");
    }

    const prereqs = await runAllowFailure(["apt-get", "install", "-y", "curl", "unzip"]);
    if (prereqs.exitCode !== 0) {
      throw new Error(prereqs.stderr.trim() || prereqs.stdout.trim() || "failed to install AWS CLI installer prerequisites");
    }

    const download = await runAllowFailure([
      "curl",
      "-fsSL",
      `https://awscli.amazonaws.com/awscli-exe-linux-${fallbackArch}.zip`,
      "-o",
      archivePath
    ]);
    if (download.exitCode !== 0) {
      throw new Error(download.stderr.trim() || download.stdout.trim() || "failed to download AWS CLI fallback archive");
    }

    const extract = await runAllowFailure(["unzip", "-q", archivePath, "-d", tempDir]);
    if (extract.exitCode !== 0) {
      throw new Error(extract.stderr.trim() || extract.stdout.trim() || "failed to extract AWS CLI fallback archive");
    }

    const fallbackInstall = await runAllowFailure([
      join(tempDir, "aws", "install"),
      "--bin-dir",
      "/usr/local/bin",
      "--install-dir",
      "/usr/local/aws-cli",
      "--update"
    ]);
    if (fallbackInstall.exitCode !== 0) {
      throw new Error(fallbackInstall.stderr.trim() || fallbackInstall.stdout.trim() || "failed to install AWS CLI");
    }
  } catch (error) {
    throw new Error(`failed to install awscli: ${String(error).replace(/^Error: /, "")}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Builds the environment used for authenticated AWS CLI calls. */
function s3Env(options: S3VerificationOptions): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: options.accessKey,
    AWS_SECRET_ACCESS_KEY: options.secretKey,
    AWS_DEFAULT_REGION: options.region || "us-east-1",
    AWS_EC2_METADATA_DISABLED: "true"
  };
}

/** Builds the common AWS CLI prefix, including custom endpoint handling. */
function s3BaseArgs(options: S3VerificationOptions): string[] {
  const args = ["aws"];
  const endpoint = normalizeS3Endpoint(options.endpoint);
  if (endpoint) {
    args.push("--endpoint-url", endpoint);
  }
  return args;
}

/**
 * Verifies that the configured S3 target exists and accepts write/delete operations.
 *
 * The probe performs a real write followed by a cleanup delete. This catches
 * wrong credentials, wrong endpoint, wrong bucket, and missing write
 * permissions instead of only testing a read-only bucket listing.
 */
export async function verifyS3Config(options: S3VerificationOptions): Promise<void> {
  if (!options.bucket) {
    throw new Error("S3 verification requires a bucket");
  }

  await ensureAwsCli();

  const env = s3Env(options);
  const baseArgs = s3BaseArgs(options);
  const tempDir = mkdtempSync(join(tmpdir(), "terrarium-s3-verify-"));
  const tempFile = join(tempDir, "probe.txt");
  const objectKey = `${options.prefix || "terrarium"}/verify/${Date.now()}-${randomUUID()}.txt`;
  writeFileSync(tempFile, `terrarium verification ${new Date().toISOString()}\n`, "utf8");

  try {
    const head = await runAllowFailure([...baseArgs, "s3api", "head-bucket", "--bucket", options.bucket], { env });
    if (head.exitCode !== 0) {
      throw new Error(head.stderr.trim() || head.stdout.trim() || `unable to access bucket ${options.bucket}`);
    }

    const put = await runAllowFailure(
      [...baseArgs, "s3api", "put-object", "--bucket", options.bucket, "--key", objectKey, "--body", tempFile],
      { env }
    );
    if (put.exitCode !== 0) {
      throw new Error(put.stderr.trim() || put.stdout.trim() || "write probe failed");
    }

    const remove = await runAllowFailure([...baseArgs, "s3api", "delete-object", "--bucket", options.bucket, "--key", objectKey], { env });
    if (remove.exitCode !== 0) {
      throw new Error(remove.stderr.trim() || remove.stdout.trim() || "delete probe failed after successful write");
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Performs a minimal, explicit fetch with a short timeout for verification probes. */
async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function verifyAuthorizationProbe(authorizationEndpoint: string, clientId: string, redirectUri: string): Promise<void> {
  const deadline = Date.now() + 120000;
  let lastStatus = 0;
  let lastBody = "";
  let lastLocation = "";

  while (Date.now() < deadline) {
    const authUrl = new URL(authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", "openid");
    authUrl.searchParams.set("state", randomUUID());
    authUrl.searchParams.set("nonce", randomUUID());
    authUrl.searchParams.set("code_challenge", Buffer.from(randomUUID()).toString("base64url"));
    authUrl.searchParams.set("code_challenge_method", "S256");

    const authResponse = await fetchWithTimeout(authUrl.toString(), { redirect: "manual" });
    const location = authResponse.headers.get("location") ?? "";
    const body = await authResponse.text().catch(() => "");
    lastStatus = authResponse.status;
    lastBody = body;
    lastLocation = location;

    if (authResponse.status < 400 && !location.includes("error=")) {
      return;
    }

    const retryable =
      authResponse.status >= 500 ||
      (authResponse.status === 400 &&
        (body.includes("Errors.App.NotFound") || body.includes("Errors.Internal") || body.includes("Errors.ResourceOwner")));
    if (!retryable) {
      break;
    }

    await Bun.sleep(5000);
  }

  if (lastStatus >= 400) {
    const suffix = lastBody ? `: ${lastBody.slice(0, 500)}` : "";
    throw new Error(`OIDC authorization probe failed for ${redirectUri} with HTTP ${lastStatus}${suffix}`);
  }
  if (lastLocation.includes("error=")) {
    throw new Error(`OIDC authorization probe was rejected for ${redirectUri}: ${lastLocation}`);
  }
}

async function verifyConfidentialClientProbe(
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: `terrarium-verification-${randomUUID()}`,
    redirect_uri: redirectUri,
    code_verifier: randomUUID()
  });
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  const tokenResponse = await fetchWithTimeout(tokenEndpoint, {
    method: "POST",
    headers: {
      authorization: `Basic ${basicAuth}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });

  const raw = await tokenResponse.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }

  if (tokenResponse.ok) {
    return;
  }

  const errorCode = String(parsed.error || "").trim();
  const errorDescription = String(parsed.error_description || "").trim();
  if (errorCode === "invalid_client" || tokenResponse.status === 401 || tokenResponse.status === 403) {
    throw new Error(errorDescription || errorCode || `OIDC token probe failed with HTTP ${tokenResponse.status}`);
  }

  if (errorCode === "invalid_grant" || [errorCode, errorDescription].some((value) => value.includes("Errors.User.Code.Invalid"))) {
    return;
  }

  throw new Error(errorDescription || errorCode || `OIDC token probe failed with HTTP ${tokenResponse.status}`);
}

/**
 * Verifies that an external OIDC issuer is reachable and that the configured
 * client credentials are at least recognized by the provider.
 *
 * The probe intentionally combines two checks:
 * - discovery plus authorization-endpoint requests for the expected callback URIs
 * - a token-endpoint confidential-client probe
 *
 * The token probe submits a deliberately invalid authorization code using
 * client authentication. A response such as `invalid_grant` proves the provider
 * recognized the client and secret before rejecting the fake code. `invalid_client`
 * still means the configured client credentials are not proven.
 */
export async function verifyOidcConfig(options: OidcVerificationOptions): Promise<void> {
  const discoveryUrl = `${options.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const discoveryResponse = await fetchWithTimeout(discoveryUrl);
  if (!discoveryResponse.ok) {
    throw new Error(`OIDC discovery failed at ${discoveryUrl} with HTTP ${discoveryResponse.status}`);
  }

  const discovery = (await discoveryResponse.json()) as Record<string, unknown>;
  const authorizationEndpoint = String(discovery.authorization_endpoint || "");
  const tokenEndpoint = String(discovery.token_endpoint || "");
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error("OIDC discovery document is missing authorization_endpoint or token_endpoint");
  }

  const manageRedirectUri = `https://${options.manageDomain}/oauth2/callback`;
  const lxdRedirectUri = `https://${options.lxdDomain}/oidc/callback`;
  const lxdClientId = options.lxdClientId || options.clientId;
  const lxdClientSecret = options.lxdClientSecret || (lxdClientId === options.clientId ? options.clientSecret : "");

  await verifyAuthorizationProbe(authorizationEndpoint, options.clientId, manageRedirectUri);
  await verifyAuthorizationProbe(authorizationEndpoint, lxdClientId, lxdRedirectUri);
  await verifyConfidentialClientProbe(tokenEndpoint, options.clientId, options.clientSecret, manageRedirectUri);
  if (lxdClientSecret && (lxdClientId !== options.clientId || lxdClientSecret !== options.clientSecret)) {
    await verifyConfidentialClientProbe(tokenEndpoint, lxdClientId, lxdClientSecret, lxdRedirectUri);
  }
}
