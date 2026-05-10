# OpenClaw on Terrarium

OpenClaw is an incredibly powerful autonomous AI agent. It needs a real Linux machine to execute code, install packages, and manipulate files. 

Running OpenClaw directly on your laptop or your main server is risky. What if it accidentally deletes a critical folder or installs conflicting software?

Terrarium is the perfect home for OpenClaw. It gives the agent a full Ubuntu container to play in. If OpenClaw makes a mess, you can just use Terrarium's time machine to instantly rewind the container to a clean state.

---

## 1. Create the Sandbox

First, let's create a fresh LXC container specifically for OpenClaw.

**From the CLI:**
```bash
lxc launch images:ubuntu/24.04 openclaw --profile dev
```

*(You can also do this visually through the **LXD UI** at `lxd.<your-domain>`. Create an `ubuntu/24.04` instance named `openclaw` and choose the `dev` profile.)*

The `dev` profile gives the normal `terrarium` user passwordless sudo inside this sandbox, which is useful for agents that need to install tools.

## 2. Install OpenClaw

It's much easier to configure OpenClaw from *inside* the container, where its interactive setup script can guide you.

Jump into the container:
```bash
trm exec openclaw
```

Now, run the official OpenClaw installer:
```bash
sudo apt-get update
sudo apt-get install -y curl
curl -fsSL https://openclaw.ai/install.sh | bash
```

Finally, run the onboarding script to set up your API keys (like OpenAI or Anthropic) and start the background daemon:
```bash
openclaw onboard --install-daemon
openclaw gateway status
```

At this point, OpenClaw is running on port `18789` inside the container.

---

## 3. How to Access the OpenClaw Web UI

There are two ways to use OpenClaw in Terrarium. 

### Method A: The Private Method (Recommended)
By default, OpenClaw's web gateway only listens on the container's local loopback address (`127.0.0.1`). 

The safest way to use OpenClaw is to leave it private and access it via an SSH tunnel or by installing Tailscale *inside* the container. This ensures the agent is completely invisible to the public internet.

### Method B: The Public Web UI Method (Advanced)
If you want to access OpenClaw's web interface from a nice URL (like `https://openclaw.your-domain.com`), you need to tell OpenClaw to listen to external traffic, set a strong password, and then tell Terrarium to publish the route.

**Inside the container**, edit the config file:
```bash
cat > ~/.openclaw/openclaw.json <<'EOF'
{
  "gateway": {
    "bind": "lan",
    "port": 18789,
    "controlUi": {
      "enabled": true,
      "allowedOrigins": ["https://openclaw.your-domain.com"]
    },
    "auth": {
      "mode": "password",
      "password": "REPLACE_WITH_A_STRONG_PASSWORD"
    }
  }
}
EOF

# Restart the gateway
openclaw gateway restart
exit
```

**Back on the Terrarium host**, apply the routing label:
```bash
lxc config set openclaw user.proxy "https://openclaw.your-domain.com:18789"
terrariumctl proxy sync
```
Terrarium will automatically grab an SSL certificate and route your custom domain directly to the OpenClaw UI.

---

## 4. Advanced: External Memory

OpenClaw stores all of its "memories" and generated artifacts as plain text Markdown files. 

If you want to be able to read and edit those files from your Macbook or Windows PC, you can connect OpenClaw to a Hetzner Storage Box using Terrarium's [External Shared Storage](../getting-started/external-shared-storage.md) feature.

Simply mount your cloud drive to `/home/terrarium/.openclaw/workspace` inside the container, and OpenClaw will save all its files directly to the cloud.
