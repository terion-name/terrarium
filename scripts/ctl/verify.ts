import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAllowFailure } from "../lib/common";

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
  manageDomain: string;
  lxdDomain: string;
};

/**
 * Ensures the AWS CLI is available before Terrarium performs S3 verification.
 *
 * Terrarium uses the CLI here because it already depends on it for backup
 * export/restore workflows and it gives us a provider-neutral test path.
 */
async function ensureAwsCli(): Promise<void> {
  const check = await runAllowFailure(["bash", "-lc", "command -v aws >/dev/null 2>&1"]);
  if (check.exitCode === 0) {
    return;
  }

  const update = await runAllowFailure(["apt-get", "update", "-y"]);
  if (update.exitCode !== 0) {
    throw new Error(`failed to install awscli: ${update.stderr.trim() || update.stdout.trim() || "apt-get update failed"}`);
  }

  const install = await runAllowFailure(["apt-get", "install", "-y", "awscli"]);
  if (install.exitCode !== 0) {
    throw new Error(`failed to install awscli: ${install.stderr.trim() || install.stdout.trim() || "apt-get install failed"}`);
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
  if (options.endpoint) {
    args.push("--endpoint-url", options.endpoint);
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

/** Builds the callback URIs Terrarium expects the shared external OIDC client to allow. */
function oidcCallbackUris(options: OidcVerificationOptions): string[] {
  return [`https://${options.manageDomain}/oauth2/callback`, `https://${options.lxdDomain}/oidc/callback`];
}

/**
 * Verifies that an external OIDC issuer is reachable and that the configured
 * client credentials are at least recognized by the provider.
 *
 * The probe intentionally combines two checks:
 * - discovery plus authorization-endpoint requests for the expected callback URIs
 * - a token-endpoint confidential-client probe
 *
 * Not every provider allows `client_credentials` for the same client Terrarium
 * uses for login. In those cases we still accept responses such as
 * `unauthorized_client` or `unsupported_grant_type`, because they prove the
 * issuer is reachable and the client credentials were recognized far enough to
 * hit grant-policy logic instead of failing as `invalid_client`.
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

  for (const redirectUri of oidcCallbackUris(options)) {
    const authUrl = new URL(authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", options.clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", "openid");
    authUrl.searchParams.set("state", randomUUID());
    authUrl.searchParams.set("nonce", randomUUID());

    const authResponse = await fetchWithTimeout(authUrl.toString(), { redirect: "manual" });
    const location = authResponse.headers.get("location") ?? "";
    if (authResponse.status >= 400) {
      throw new Error(`OIDC authorization probe failed for ${redirectUri} with HTTP ${authResponse.status}`);
    }
    if (location.includes("error=")) {
      throw new Error(`OIDC authorization probe was rejected for ${redirectUri}: ${location}`);
    }
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "openid"
  });
  const basicAuth = Buffer.from(`${options.clientId}:${options.clientSecret}`, "utf8").toString("base64");
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

  if (["unauthorized_client", "unsupported_grant_type", "invalid_scope", "access_denied", "invalid_grant"].includes(errorCode)) {
    return;
  }

  throw new Error(errorDescription || errorCode || `OIDC token probe failed with HTTP ${tokenResponse.status}`);
}
