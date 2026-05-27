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

## 3. Enable the Hermes API and Service

Hermes includes a built-in API server that you can publish to the internet. 

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

Hermes manages its own systemd units, so do not create a custom Terrarium unit. For a VPS or headless Terrarium container, install the boot-time system service:
```bash
sudo hermes gateway install --system
sudo hermes gateway start --system
sudo hermes gateway status --system
```

To follow logs:
```bash
journalctl -u hermes-gateway -f
```

For a user service instead:
```bash
hermes gateway install
hermes gateway start
hermes gateway status
journalctl --user -u hermes-gateway -f
```

Use the system service for containers you expect to survive logout and restart cleanly after host reboots. Avoid keeping both the user service and the system service installed for the same Hermes home unless you intentionally want two separate gateway processes.

Now, exit the container:
```bash
exit
```

## 4. Choose How the Public Route Is Authenticated

Now that Hermes is running inside the private network on port `8642`, decide which layer should authenticate public requests.

### Option A: Hermes Gateway Auth

Use this when you want API clients, scripts, or integrations to call Hermes directly with Hermes' own API key.

Run this on the host:
```bash
lxc config set hermes user.proxy "https://hermes.example.com:8642"
terrariumctl proxy sync
```

Terrarium will instantly:
- Provision a Let's Encrypt SSL certificate for `hermes.example.com`.
- Route traffic from that domain directly to your Hermes API server.

Hermes is responsible for request authorization in this mode. Keep `API_SERVER_KEY` set to a long random value and use that key from your clients.

Hermes' messaging gateway also has its own access model for chat platforms. Use Hermes allowlists, pairing, and admin/user settings for Telegram, Discord, Slack, and other messaging adapters. Those checks happen inside Hermes after the platform delivers a message.

### Option B: Terrarium SSO with OAuth2-Proxy

Use this when the public Hermes endpoint is mainly for humans in a browser and you want the same Terrarium SSO gate used by Cockpit, LXD, and protected app routes.

Run this on the host:
```bash
lxc config set hermes user.proxy "https://hermes.example.com:8642@auth"
terrariumctl proxy sync
```

To restrict access to a group emitted by your OIDC provider:
```bash
lxc config set hermes user.proxy "https://hermes.example.com:8642@auth:agents"
terrariumctl proxy sync
```

In this mode Terrarium's oauth2-proxy handles the browser login before traffic reaches Hermes. You can still keep `API_SERVER_KEY` enabled as a second application-level guard, especially if you also expect non-browser API clients.

## Advanced: Store Memories externally

Hermes keeps its memories as plain Markdown files. By default, these live at `~/.hermes/memories/MEMORY.md`. 

If you want to read and edit those memories from your own laptop or another server, you can use Terrarium's [External Shared Storage](../getting-started/external-shared-storage.md) feature to mount an external cloud drive directly into the container. 

Map your external Hetzner Storage Box to `/home/terrarium/.hermes/memories` to create a cloud-backed memory bank for your AI agents.
