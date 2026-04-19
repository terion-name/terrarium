# OpenClaw on Terrarium

OpenClaw is exactly the kind of workload that makes Terrarium useful: it wants a real machine, not a tiny sandbox, and it is powerful enough that you probably do not want it living directly on your host.

Terrarium gives OpenClaw a full Ubuntu LXC with its own packages, workspace, and long-lived state. That means OpenClaw can behave like a real agent environment, while the Terrarium host stays hardened and recoverable.

## Why Terrarium fits OpenClaw

- Security: the OpenClaw runtime is isolated from the host.
- Isolation: one agent environment does not interfere with another.
- Time machine: if the workspace drifts or the agent damages the environment, you can step the container back to a recent snapshot.
- Realism: OpenClaw gets the kind of mutable Linux environment it expects.

## Important networking note

OpenClaw is not the same as Hermes or `codium serve-web`.

Upstream explicitly recommends keeping the gateway on loopback and accessing it through SSH tunneling or Tailscale for the normal Linux-server case. If you bind it to a non-loopback address, upstream requires explicit gateway auth, and Control UI deployments on non-loopback addresses also need `gateway.controlUi.allowedOrigins` configured.

So there are two real Terrarium patterns:

1. the recommended upstream pattern: private gateway, accessed through SSH tunnel or Tailscale
2. a public-through-Traefik pattern: possible, but only with explicit auth and origin configuration

## Create the container

You can do this either in the LXD UI or from the CLI.

In the LXD UI:

1. Open `https://lxd.<your-domain>` and log in.
2. Create a new instance from the `images:ubuntu/24.04` image.
3. Name it `openclaw`.
4. Start the container.

From the CLI:

```bash
lxc launch images:ubuntu/24.04 openclaw
```

## Recommended setup: enter the container and use OpenClaw the way it expects

For OpenClaw, this is the path I would actually recommend to a human. The onboarding flow is interactive and opinionated, and using it from inside the container is much more comfortable.

Open a shell in the container:

```bash
lxc exec openclaw -- bash
```

Then run the setup inside that shell:

```bash
apt-get update
apt-get install -y curl
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
openclaw gateway status
```

The onboarding flow is where you should configure:

- model provider credentials
- gateway authentication
- daemon install
- any other OpenClaw preferences

By default, you should end up with the gateway on port `18789`.

## Recommended access pattern: keep OpenClaw private

This is the path upstream recommends for Linux VPS deployments.

Keep the gateway on loopback, then access it from your laptop with SSH:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@your-terrarium-host
```

Then open:

```text
http://127.0.0.1:18789/
```

This works well with Terrarium because:

- OpenClaw stays private inside the LXC
- the host stays simple
- you still get ZFS snapshots and container isolation

If you prefer Tailscale, upstream also documents Tailscale Serve and Funnel support for the gateway.

## Public-through-Terrarium setup

If you specifically want OpenClaw published on a public hostname through Terrarium, do not use the default loopback-only setup. Configure non-loopback bind plus explicit auth.

Go back into the container:

```bash
lxc exec openclaw -- bash
```

Create or update `~/.openclaw/openclaw.json`:

```bash
cat > ~/.openclaw/openclaw.json <<'EOF'
{
  gateway: {
    bind: 'lan',
    port: 18789,
    controlUi: {
      enabled: true,
      allowedOrigins: ['https://openclaw.example.com']
    },
    auth: {
      mode: 'password'
    }
  }
}
EOF
```

Set the gateway password and restart the gateway:

```bash
export OPENCLAW_GATEWAY_PASSWORD='replace-with-a-long-random-secret'
openclaw gateway restart
```

Leave the container shell, then publish it from the host:

```bash
lxc config set openclaw user.proxy "https://openclaw.example.com:18789"
terrariumctl proxy sync
```

That gives you:

- OpenClaw listening on the container network instead of loopback only
- OpenClaw still protected by its own password auth
- Traefik handling TLS and hostname routing on the host

## Automation version

If you want the setup condensed into host-side commands, this is the scriptable path:

```bash
lxc launch images:ubuntu/24.04 openclaw
lxc exec openclaw -- bash -lc 'apt-get update && apt-get install -y curl'
lxc exec openclaw -- bash -lc 'curl -fsSL https://openclaw.ai/install.sh | bash'
lxc exec openclaw -- bash -lc 'openclaw onboard --install-daemon'
lxc exec openclaw -- bash -lc "cat > ~/.openclaw/openclaw.json <<'EOF'
{
  gateway: {
    bind: 'lan',
    port: 18789,
    controlUi: {
      enabled: true,
      allowedOrigins: ['https://openclaw.example.com']
    },
    auth: {
      mode: 'password'
    }
  }
}
EOF"
lxc exec openclaw -- bash -lc "export OPENCLAW_GATEWAY_PASSWORD='replace-with-a-long-random-secret' && openclaw gateway restart"
lxc config set openclaw user.proxy "https://openclaw.example.com:18789"
terrariumctl proxy sync
```

Use that only if you already know your OpenClaw answers and do not need to work through the onboarding flow manually.

## When to use trusted-proxy mode

OpenClaw also supports `trusted-proxy` auth for identity-aware reverse proxies. Upstream documents this for setups like Pomerium, nginx + `oauth2-proxy`, Caddy + OAuth, or Traefik + forward auth.

That is useful if you want OpenClaw access controlled by SSO instead of a shared token or password. But it is also easier to misconfigure.

Important upstream rule:

- same-host loopback reverse proxies do not satisfy trusted-proxy auth
- OpenClaw must see requests coming from a non-loopback trusted proxy source listed in `gateway.trustedProxies`

So if you want to combine OpenClaw with an identity-aware proxy, follow OpenClaw's trusted-proxy documentation carefully and treat that as a deliberate advanced setup, not the default starting point.

## Recommended workflow

1. Install and onboard OpenClaw in its own LXC.
2. Start with the private loopback pattern first.
3. Snapshot the container once onboarding and provider auth are working.
4. Only then decide whether you actually need public access through Traefik.

That keeps the initial setup simpler and safer, while still giving you a clear upgrade path to a public or SSO-gated deployment later.

## Upstream docs used for this guide

- [OpenClaw getting started](https://docs.openclaw.ai/start/getting-started)
- [OpenClaw Linux server guide](https://docs.openclaw.ai/vps)
- [OpenClaw web and Control UI security notes](https://docs.openclaw.ai/web)
- [OpenClaw remote access](https://docs.openclaw.ai/gateway/remote)
- [OpenClaw Tailscale guide](https://docs.openclaw.ai/gateway/tailscale)
- [OpenClaw trusted proxy auth](https://docs.openclaw.ai/gateway/trusted-proxy-auth)
