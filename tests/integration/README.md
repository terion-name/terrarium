# Real-Infra Integration Suite

This directory contains Terrarium’s real-infrastructure integration harness.

It provisions ephemeral Hetzner Cloud servers and volumes, configures real DNS,
OIDC, S3, and SMB dependencies, installs Terrarium on those hosts, and then
exercises the shipped CLI and runtime features end to end.

## Entry points

```bash
bun run integration:smoke
bun run integration:full
```

Or directly:

```bash
bun run tests/integration/index.ts --suite smoke
bun run tests/integration/index.ts --suite full
```

Useful flags:

```bash
bun run tests/integration/index.ts --suite full --only full
bun run tests/integration/index.ts --suite smoke --keep-on-failure
```

## Required environment

The harness expects these environment variables:

- `HCLOUD_TOKEN`
- `HCLOUD_LOCATION`
- `HCLOUD_SERVER_TYPE`
- `HCLOUD_BINARY_TARGET` (optional, defaults to `x64`)
- `HCLOUD_SSH_PRIVATE_KEY`
- `HCLOUD_SSH_PUBLIC_KEY`
- `DUCKDNS_DOMAIN`
- `DUCKDNS_TOKEN`
- `ZITADEL_CLOUD_ISSUER`
- `ZITADEL_CLOUD_PAT`
- `ZITADEL_CLOUD_ORG_ID` (optional when the PAT has enough scope without it)
- `S3_ENDPOINT`
- `S3_BUCKET`
- `S3_REGION`
- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`
- `CIFS_ADDRESS`
- `CIFS_USERNAME`
- `CIFS_PASSWORD`
- `CIFS_HOST_PATH_BASE`

## Output

Each run writes logs, screenshots, and collected host artifacts to:

```text
tests/integration/output/<run-slug>/
```
