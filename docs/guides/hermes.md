# Hermes on Terrarium

Hermes is an AI agent that works in the background. Like OpenClaw, it wants a full Linux environment with shell access, the ability to run multiple processes, and a place to install packages over time.

Terrarium is the perfect host for Hermes because it gives the agent a powerful sandbox to experiment in, without risking your primary server. It also makes exposing the Hermes Web API incredibly simple using the built-in Traefik proxy.

---

## 1. Create the Container

You can do this visually in the LXD UI or from the CLI.

**From the CLI:**
```bash
lxc launch ubuntu:24.04 hermes --profile dev
```

*(You can also use the **LXD UI** at `lxd.<your-domain>` to create a new `ubuntu/24.04` instance named `hermes` with the `dev` profile.)*

The `dev` profile lets the normal `terrarium` user use passwordless sudo inside the container, which is handy for agent runtimes that install packages over time.

## 2. Install Hermes

Hermes has a great interactive setup script, so the easiest way to install it is to jump inside the container and let it guide you.

Enter the container:
```bash
trm exec hermes
```

Update the system and install the required tools:
```bash
sudo apt-get update
sudo apt-get install -y git curl
```

Download and run the official installer:
```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
source ~/.bashrc
```

Finally, start the interactive setup to configure your API keys (like OpenRouter) and preferences:
```bash
hermes setup
```

## 3. Configure the Gateway and OpenAI-Compatible API

Hermes includes a gateway and an OpenAI-compatible API server. Run the gateway setup first:

```bash
hermes gateway setup
```

The setup wizard configures messaging platforms and can offer to install/start the gateway service for you. If it does, you can accept that and skip the manual service commands below.

The API endpoint is meant for API clients, so do not put Terrarium's browser OAuth gate in front of it. OpenAI-compatible clients expect API-key style authentication, not an OAuth redirect flow.

We need to tell Hermes to listen on all interfaces (`0.0.0.0`) so that Terrarium's Traefik proxy can forward traffic to it.

Still inside the container, append these settings to the Hermes config file:

```bash
cat >> ~/.hermes/.env <<'EOF'
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
API_SERVER_KEY=replace-with-a-long-random-secret
API_SERVER_CORS_ORIGINS=https://hermes.example.com
EOF
```

If the setup wizard did not already install and start the gateway, use Hermes' own user service under the `terrarium` user. Enable lingering so the service can survive logout and start after container boot:
```bash
sudo loginctl enable-linger terrarium
hermes gateway install
hermes gateway start
hermes gateway status
```

To follow logs:
```bash
journalctl --user -u hermes-gateway -f
```

If the user service does not come back after a container reboot, use Hermes' system-service mode as a fallback. `sudo` usually does not inherit the `terrarium` user's `PATH`, so resolve the Hermes binary first and pass the full path to `sudo`:
```bash
HERMES_BIN="$(command -v hermes)"
sudo "$HERMES_BIN" gateway install --system
sudo "$HERMES_BIN" gateway start --system
sudo "$HERMES_BIN" gateway status --system
journalctl -u hermes-gateway -f
```

Avoid keeping both the user service and the system service installed for the same Hermes home unless you intentionally want two separate gateway processes.

## 4. Optional: Run the Web Dashboard

Hermes also ships a browser dashboard for configuration, sessions, logs, API keys, analytics, cron jobs, and skills. The dashboard reads and writes sensitive files like `~/.hermes/.env`, so publish it only behind Terrarium SSO.

Install the dashboard extras if your Hermes install did not include them:
```bash
sudo apt install python3-pip pipx -y
pipx install 'hermes-agent[web,pty]'
```

Create a user service for the dashboard:
```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/hermes-dashboard.service <<'EOF'
[Unit]
Description=Hermes web dashboard
After=network-online.target hermes-gateway.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
ExecStart=/bin/bash -lc 'exec hermes dashboard --host 0.0.0.0 --port 9119 --no-open --insecure --tui'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now hermes-dashboard.service
systemctl --user status hermes-dashboard.service
```

`--insecure` disables Hermes' own public-dashboard OAuth behavior. That is intentional here because Terrarium's oauth2-proxy will be the public authentication layer. Do not publish the dashboard without `@auth`.

Now, exit the container:
```bash
exit
```

## 5. Publish the Routes with Terrarium

`user.proxy` is one LXD config key. If you publish both the API and the dashboard, put both routes in the same comma-separated value.

Publish the OpenAI-compatible API endpoint without Terrarium `@auth`, and publish the dashboard with Terrarium SSO:

Run this on the host:
```bash
lxc config set hermes user.proxy "https://hermes-api.example.com:8642,https://hermes-dashboard.example.com:9119@auth"
terrariumctl proxy sync
```

Terrarium will instantly:
- Provision a Let's Encrypt SSL certificate for `hermes-api.example.com`.
- Route traffic from that domain directly to your Hermes API server.
- Provision a Let's Encrypt SSL certificate for `hermes-dashboard.example.com`.
- Protect the dashboard with oauth2-proxy before traffic reaches Hermes.

If your Terrarium install uses the local managed ZITADEL, `terrariumctl proxy sync` also updates the route-auth callback URL in ZITADEL automatically. With an external provider such as ZITADEL Cloud, add the dashboard callback URL to that provider manually. For the root dashboard route above, add:
```text
https://hermes-dashboard.example.com/oauth2/callback
```

Hermes is responsible for API request authorization. Keep `API_SERVER_KEY` set to a long random value and use that key from OpenAI-compatible clients.

Hermes' messaging gateway also has its own access model for chat platforms. Use Hermes allowlists, pairing, and admin/user settings for Telegram, Discord, Slack, and other messaging adapters. Those checks happen inside Hermes after the platform delivers a message.

To restrict access to a group emitted by your OIDC provider:
```bash
lxc config set hermes user.proxy "https://hermes-api.example.com:8642,https://hermes-dashboard.example.com:9119@auth:admins"
terrariumctl proxy sync
```

In this mode Terrarium's oauth2-proxy handles browser login before traffic reaches the dashboard.

## Advanced: Store Memories externally

Hermes keeps its memories as plain Markdown files. By default, these live at `~/.hermes/memories/MEMORY.md`. 

If you want to read and edit those memories from your own laptop or another server, you can use Terrarium's [External Shared Storage](../getting-started/external-shared-storage.md) feature to mount an external cloud drive directly into the container. 

After you mount your Storage Box on the host, create a dedicated directory and attach it into the Hermes container:

```bash
sudo mkdir -p /srv/shared/storage-box/hermes/memories
lxc config device add hermes hermes-memories disk source=/srv/shared/storage-box/hermes/memories path=/home/terrarium/.hermes/memories
lxc exec hermes -- chown -R terrarium:terrarium /home/terrarium/.hermes/memories
```

This gives Hermes a cloud-backed memory directory while keeping the agent runtime itself inside the container.
