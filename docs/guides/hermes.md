# Hermes on Terrarium

Hermes is a very natural Terrarium workload: it wants a real Linux environment, shell access, mutable state, and enough room to install tools over time. Terrarium gives Hermes that freedom inside its own LXC, while the host stays hardened and easy to roll back around it.

This is a strong fit when you want an agent to have real power, but you do not want that power landing directly on the VPS host.

## Why this works well

- Security: Hermes runs inside its own container instead of directly on the host.
- Isolation: its packages, caches, logs, and sessions stay in one place.
- Rewindability: if the environment drifts or the agent breaks its own dependencies, you can restore the container to a recent snapshot.
- Networking: Hermes exposes an HTTP API cleanly, so it fits Terrarium's built-in Traefik automation very well.

## Create the container

You can do this either in the LXD UI or from the CLI.

In the LXD UI:

1. Open `https://lxd.<your-domain>` and log in.
2. Create a new instance from the `images:ubuntu/24.04` image.
3. Name it `hermes`.
4. Start the container.

From the CLI:

```bash
lxc launch images:ubuntu/24.04 hermes
```

## Recommended setup: enter the container and do the human part there

For Hermes, this is the path I would actually recommend to a person. The installer and setup flow are interactive, and using them from inside the container is much more humane than trying to tunnel every step through repeated host-side one-liners.

Open a shell in the container:

```bash
lxc exec hermes -- bash
```

Then run the setup inside that shell:

```bash
apt-get update
apt-get install -y git curl
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
source ~/.bashrc
hermes setup
```

At that point, let Hermes walk you through the interactive setup. That is where you should configure:

- the model provider
- credentials such as `OPENROUTER_API_KEY`
- tool preferences
- any gateway integrations you want

## Expose the Hermes API through Terrarium

Hermes has a documented API server. That is the piece you should expose through Terrarium.

Still inside the container shell, append the API server settings:

```bash
cat >> ~/.hermes/.env <<'EOF'
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
API_SERVER_KEY=replace-with-a-long-random-secret
API_SERVER_CORS_ORIGINS=https://hermes.example.com
EOF
```

Start the API server:

```bash
hermes gateway
```

Leave the container shell, then publish it from the host:

```bash
lxc config set hermes user.proxy "https://hermes.example.com:8642"
terrariumctl proxy sync
```

That gives you:

- Hermes listening on `0.0.0.0:8642` inside the LXC
- Traefik terminating TLS on the host
- automatic routing from `https://hermes.example.com` to the container

## Make it persistent

Go back into the container:

```bash
lxc exec hermes -- bash
```

Create a systemd unit:

```bash
cat > /etc/systemd/system/hermes-gateway.service <<'EOF'
[Unit]
Description=Hermes API gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Environment=HOME=/root
ExecStart=/bin/bash -lc 'source ~/.bashrc && hermes gateway'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now hermes-gateway.service
```

## Automation version

If you want the same setup condensed into host-side commands, this is the scriptable path:

```bash
lxc launch images:ubuntu/24.04 hermes
lxc exec hermes -- bash -lc 'apt-get update && apt-get install -y git curl'
lxc exec hermes -- bash -lc 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash'
lxc exec hermes -- bash -lc "cat >> ~/.hermes/.env <<'EOF'
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
API_SERVER_KEY=replace-with-a-long-random-secret
API_SERVER_CORS_ORIGINS=https://hermes.example.com
EOF"
lxc exec hermes -- bash -lc "cat > /etc/systemd/system/hermes-gateway.service <<'EOF'
[Unit]
Description=Hermes API gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Environment=HOME=/root
ExecStart=/bin/bash -lc 'source ~/.bashrc && hermes gateway'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now hermes-gateway.service"
lxc config set hermes user.proxy "https://hermes.example.com:8642"
terrariumctl proxy sync
```

Use that only if you already know your Hermes config inputs and do not need the interactive setup flow.

## Notes from upstream docs

- The Hermes installer needs only `git`; it installs Python 3.11, Node.js v22, `uv`, `ripgrep`, and `ffmpeg` automatically.
- The API server defaults to `127.0.0.1:8642`.
- When binding to a non-loopback address like `0.0.0.0`, `API_SERVER_KEY` is required.
- Browser CORS is off by default, so you should set `API_SERVER_CORS_ORIGINS` explicitly when exposing it through a browser-facing hostname.

## Upstream docs used for this guide

- [Hermes installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation/)
- [Hermes API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/)
