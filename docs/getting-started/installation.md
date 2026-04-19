# Installation

Terrarium installs onto a single Ubuntu 24.04 VPS and turns it into a hardened host for LXD containers on ZFS.

## Requirements

- Ubuntu Server 24.04 LTS
- root access on the host
- SSH key-based access
- either:
  - a dedicated extra disk for the LXD ZFS pool, which is the recommended setup
  - or enough root-disk space to use `--storage-mode file`

If you still need to create the VPS itself, start with the provider setup guides:

- [DigitalOcean](../providers/digitalocean.md)
- [Vultr](../providers/vultr.md)
- [Hetzner Cloud](../providers/hetzner.md)
- [Hostinger](../providers/hostinger.md)

Or browse the full [Provider Guides](../providers/README.md) section first.

## Recommended Install

```bash
curl -fsSL https://github.com/terion-name/terrarium/releases/latest/download/install.sh | bash
```

The published `install.sh` is intentionally thin. It downloads the matching compiled `terrariumctl` bundle from GitHub Releases, stages it into `/opt/terrarium`, and runs the real installer there.

If you want to pin a specific release instead of `latest`, use the tagged asset directly:

```bash
curl -fsSL https://github.com/terion-name/terrarium/releases/download/0.0.0-beta3/install.sh | bash
```

## Install Modes

Interactive mode is the default and is the best fit for most first installs.

```bash
curl -fsSL https://github.com/terion-name/terrarium/releases/latest/download/install.sh | bash
```

Non-interactive mode is for automation, templates, or repeated installs:

```bash
curl -fsSL https://github.com/terion-name/terrarium/releases/latest/download/install.sh | bash -s -- \
  --non-interactive \
  --email admin@your-domain.tld \
  --acme-email certs@your-domain.tld \
  --idp local \
  --storage-mode file \
  --yes
```

## Storage Modes

Terrarium supports three storage modes:

- `disk`
  Use a dedicated non-root disk for the ZFS pool. This is the recommended production setup.
- `partition`
  Use an existing unused partition or allocatable free space on a non-root disk.
- `file`
  Create a file-backed ZFS pool on the root filesystem. This is the fallback when there is no extra disk.

Important notes:

- Terrarium does not shrink the mounted root filesystem.
- In interactive mode, `partition` mode discovers allocatable targets, suggests the largest one, and asks for confirmation.
- In non-interactive mode, `--storage-source` is required for `disk` and `partition`.
- You can use `--storage-source auto` to let Terrarium pick the largest valid non-root target automatically.

## First Decisions During Install

The installer will guide you through:

- contact email and ACME email
- domain setup
- IDP mode:
  - `local` for self-hosted ZITADEL
  - `oidc` for an external OIDC provider
- storage mode and storage source
- optional S3 archive backups
- optional syncoid replication

Terrarium also verifies the most failure-prone integrations while you configure them:

- external OIDC settings are probed against the issuer, callback flow, and client credentials before install continues
- S3 settings are tested with a real write/delete probe against the configured bucket

In interactive mode, failed verification sends you back to the relevant prompts. In non-interactive mode, install exits with an error instead of persisting broken settings.

## After Install

Terrarium keeps:

- the repo checkout at `/opt/terrarium`
- the resolved host config at `/etc/terrarium/config.yaml`

From there, the main commands you will use are:

- `terrariumctl status`
- `terrariumctl set ...`
- `terrariumctl proxy sync`
- `terrariumctl backup ...`

For full command details, see [terrariumctl Reference](../reference/terrariumctl.md).
