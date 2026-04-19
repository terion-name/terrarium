# About Terrarium

Terrarium is a way to turn a plain Ubuntu 24.04 VPS into a safer, easier home for isolated environments.

It is built for a very practical problem: modern agents, dev tools, and self-hosted apps often need more freedom than Docker alone feels comfortable giving them, but giving that freedom directly to your host is a bad trade. Terrarium sits in the middle. Each workload gets its own LXC container on ZFS, the host stays hardened, and you still get convenient web UIs and automated publishing when you need them.

## What It Is For

Terrarium is a strong fit when you want to run things like:

- agent systems such as OpenClaw or Hermes
- browser-based development environments like VSCodium Web
- temporary sandboxes for experiments or client work
- self-hosted apps or Docker Compose stacks that should not interfere with each other

The point is not just “run containers”. The point is to give each workload a real environment with enough freedom to be useful, while keeping the host and the other workloads out of the blast radius.

## Why People Use It

Terrarium gives you a few important properties at the same time:

- **Isolation**
  Each workload lives in its own container, with its own packages, processes, filesystem, and state.
- **Private-by-default networking**
  Containers sit behind LXD NAT, so listening inside a container does not automatically make a service public.
- **A built-in time machine**
  ZFS snapshots let you step backward through mistakes, failed upgrades, or agent damage instead of rebuilding from scratch.
- **Disaster recovery**
  If you enable S3 exports, recovery is not limited to the local disk. You also get an off-host path for losing the whole VPS.
- **Friendly management**
  Cockpit, the LXD UI, and the Traefik dashboard give you visual control surfaces when you do not want everything to live in a terminal.

## How To Think About It

The simplest mental model is:

1. Put each meaningful workload in its own container.
2. Keep that workload private until you are ready to expose it.
3. Publish only the routes you actually want reachable.
4. Use snapshots as your day-to-day time machine.
5. Use S3 exports if you want disaster recovery beyond the machine itself.

That makes Terrarium especially useful for advanced users who want power and flexibility, but do not want to become full-time infrastructure engineers just to host agents or dev environments safely.

## What To Read Next

If you are new here:

1. Start with [Getting Started](./getting-started/).
2. Read [Storage and Sizing](./getting-started/storage) before creating a VPS.
3. If you are still choosing a provider, use the [Provider Guides](./providers/).

If you want to understand how the system behaves:

1. Read the [Security Model](./security).
2. Read the [Architecture](./architecture).
3. Check [Management GUIs](./getting-started/management-guis) if you want the visual control plane.

If you already know what you want to run:

1. Go to [Guides](./guides/).
2. Pick a workload like [OpenClaw](./guides/openclaw), [Hermes](./guides/hermes), [VSCodium Web](./guides/vscode), or [Compose deployments](./guides/compose).

If you are thinking about operations and recovery:

1. Read [Backups and Restore](./operations/backups-and-restore).
2. Keep the [terrariumctl Reference](./reference/terrariumctl) nearby.
