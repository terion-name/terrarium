# Terrarium Docs

Terrarium turns a plain Ubuntu 24.04 VPS into a secure, rewindable home for isolated environments.

It is built for the way people actually use agents and development tools now: giving software enough freedom to be useful, without giving it the whole host. Agent systems like OpenClaw, Hermes, browser-based editors, internal dashboards, and temporary development environments can run inside real LXD containers on ZFS, while the host stays hardened and recoverable.

That gives you three things at once:

- isolation, so one workload does not become everyone else's problem
- rewindability, so a broken environment can be rolled back instead of rebuilt
- easy publishing, so containerized web apps can be exposed through Traefik with TLS and optional OIDC protection

One of the most important parts is easy to miss if you are not already deep into infrastructure: Terrarium containers are not exposed directly to the internet. They sit behind LXD's private bridge and NAT by default, which means random inbound scans, probes, and malicious requests do not hit them directly. A service only becomes public when you explicitly publish it through Terrarium's proxy system.

If you are new to Terrarium, start here:

- [Getting Started](/getting-started/)
- [Security Model](/security)
- [Provider Guides](/providers/)
- [Use-case Guides](/guides/)
- [Operations](/operations/)
- [Reference](/reference/)
- [Architecture](/architecture)

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

## Why The Default Network Model Matters

Terrarium is opinionated in a useful way:

- containers live on a private LXD network behind NAT
- host-level exposure is explicit
- only the routes or ports you publish are reachable from outside

That means you can run messy or complex workloads more safely. For example, a Docker Compose stack inside an LXC can expose a web app, a database, Redis, internal admin ports, and metrics inside that container network, but nothing is reachable from the public internet unless you deliberately put it behind Terrarium's proxy or raw port publishing.

For advanced users, this means more freedom. For non-experts, it means fewer accidental mistakes turn into public incidents.
