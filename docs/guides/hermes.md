# Hermes on Terrarium

Hermes is an AI agent that works in the background. Like OpenClaw, it wants a full Linux environment with shell access, the ability to run multiple processes, and a place to install packages over time.

Terrarium is the perfect host for Hermes because it gives the agent a powerful sandbox to experiment in, without risking your primary server. It also makes exposing the Hermes Web API incredibly simple using the built-in Traefik proxy.

---

## 1. Create the Container

You can do this visually in the LXD UI or from the CLI.

**From the CLI:**
```bash
lxc launch images:ubuntu/24.04 hermes
```

*(You can also use the **LXD UI** at `lxd.<your-domain>` to create a new `ubuntu/24.04` instance named `hermes`.)*

## 2. Install Hermes

Hermes has a great interactive setup script, so the easiest way to install it is to jump inside the container and let it guide you.

Enter the container:
```bash
lxc exec hermes -- bash
```

Update the system and install the required tools:
```bash
apt-get update
apt-get install -y git curl
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

## 3. Expose the Hermes API

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

Start the API server:
```bash
hermes gateway
```

Now, exit the container:
```bash
exit
```

## 4. Publish the Route with Terrarium

Now that Hermes is running inside the private network on port `8642`, let's publish it securely to the public internet using Terrarium's `user.proxy` label.

Run this on the host:
```bash
lxc config set hermes user.proxy "https://hermes.example.com:8642"
terrariumctl proxy sync
```

Terrarium will instantly:
- Provision a Let's Encrypt SSL certificate for `hermes.example.com`.
- Route traffic from that domain directly to your Hermes API server.

## 5. Keep Hermes Running Automatically (Systemd)

If your server reboots, you want Hermes to start back up automatically.

Go back inside the container:
```bash
lxc exec hermes -- bash
```

Create a systemd service:
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

## Advanced: Store Memories externally

Hermes keeps its memories as plain Markdown files. By default, these live at `~/.hermes/memories/MEMORY.md`. 

If you want to read and edit those memories from your own laptop or another server, you can use Terrarium's [External Shared Storage](../getting-started/external-shared-storage.md) feature to mount an external cloud drive directly into the container. 

Map your external Hetzner Storage Box to `/root/.hermes/memories` to create a cloud-backed memory bank for your AI agents.