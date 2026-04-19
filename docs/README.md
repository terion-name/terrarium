# Terrarium Docs

Terrarium turns a plain Ubuntu 24.04 VPS into a secure, rewindable home for isolated environments.

It is built for the way people actually use agents and development tools now: giving software enough freedom to be useful, without giving it the whole host. Agent systems like OpenClaw, Hermes, browser-based editors, internal dashboards, and temporary development environments can run inside real LXD containers on ZFS, while the host stays hardened and recoverable.

That gives you three things at once:

- isolation, so one workload does not become everyone else's problem
- rewindability, so a broken environment can be rolled back instead of rebuilt
- easy publishing, so containerized web apps can be exposed through Traefik with TLS and optional OIDC protection

If you are new to Terrarium, start here:

- [Getting Started](getting-started/README.md)
- [Provider Guides](providers/README.md)
- [Use-case Guides](guides/README.md)
- [Operations](operations/README.md)
- [Reference](reference/README.md)
- [Architecture](architecture.md)

## What Terrarium Installs

Terrarium provisions a host with:

- [Cockpit](https://github.com/cockpit-project/cockpit)
- [`45Drives/cockpit-zfs`](https://github.com/45Drives/cockpit-zfs)
- [`45Drives/cockpit-S3ObjectBroswer`](https://github.com/45Drives/cockpit-S3ObjectBroswer)
- [LXD](https://github.com/canonical/lxd) with the built-in web UI
- [OpenZFS](https://github.com/openzfs/zfs)
- [`sanoid` and `syncoid`](https://github.com/jimsalterjrs/sanoid)
- [Traefik](https://github.com/traefik/traefik)
- [oauth2-proxy](https://github.com/oauth2-proxy/oauth2-proxy)
- Optional self-hosted [ZITADEL](https://github.com/zitadel/zitadel)
- [`devsec.hardening`](https://github.com/dev-sec/ansible-collection-hardening)

## Supported Scope

- Ubuntu Server 24.04 LTS
- Single-host install only
- LXC containers only

## Common Paths Through The Docs

If you want to get a box online quickly:

1. Read [Installation](getting-started/installation.md)
2. Read [Storage and Sizing](getting-started/storage.md)
3. Pick your provider from [Provider Guides](providers/README.md)

If you want to understand auth and management access:

1. Read [Domains and Authentication](getting-started/domains-and-auth.md)
2. Read [Protecting Published Services with OIDC](guides/auth-protection.md)

If you want day-2 operations:

1. Read [Reconfiguration](operations/reconfiguration.md)
2. Read [Backups and Restore](operations/backups-and-restore.md)
3. Use [terrariumctl Reference](reference/terrariumctl.md)
