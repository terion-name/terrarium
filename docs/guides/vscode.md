# VSCodium Web IDE on Terrarium

Imagine having a full, powerful coding environment running in the cloud that you can access from any web browser. That's what `VSCodium` offers. 

Unlike Microsoft's branded VS Code or the legacy `code-server`, VSCodium is fully open-source and uses the open extension marketplace by default.

Running your cloud IDE in Terrarium is the ultimate developer flex:
- **Total Isolation:** Your code, extensions, and terminal commands live inside a secure container.
- **The Time Machine:** Accidentally wipe your project or install a broken package? Just rewind the container to an hour ago.
- **Access Anywhere:** Terrarium securely publishes the editor to your custom domain.

---

## 1. Create the Devbox

Let's spin up a fresh container just for coding.

**From the CLI:**
```bash
lxc launch images:ubuntu/24.04 devbox
```

*(You can also use the **LXD UI** at `lxd.<your-domain>`.)*

## 2. Install VSCodium

Jump into your new container:
```bash
lxc exec devbox -- bash
```

Run these commands to add the VSCodium repository and install the editor:
```bash
apt-get update
apt-get install -y wget gpg apt-transport-https openssl ca-certificates

wget https://gitlab.com/paulcarroty/vscodium-deb-rpm-repo/raw/master/pub.gpg \
  -O /usr/share/keyrings/vscodium-archive-keyring.asc

echo 'deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/vscodium-archive-keyring.asc ] https://paulcarroty.gitlab.io/vscodium-deb-rpm-repo/debs vscodium main' \
  > /etc/apt/sources.list.d/vscodium.list

apt-get update
apt-get install -y codium
```

## 3. Secure and Start the Editor

We need to generate a secure "Connection Token" so that only *you* can log into the editor. 

Still inside the container, run:
```bash
install -d -m 0700 /etc/codium-web
openssl rand -hex 32 > /etc/codium-web/token
chmod 600 /etc/codium-web/token
```

Now, let's create a background service so VSCodium starts automatically if the container reboots:
```bash
cat > /etc/systemd/system/codium-web.service <<'EOF'
[Unit]
Description=VSCodium Web Server
After=network.target

[Service]
User=root
Group=root
WorkingDirectory=/root
ExecStart=/bin/bash -lc '/usr/bin/codium serve-web --host 0.0.0.0 --port 8080 --connection-token "$(cat /etc/codium-web/token)" --accept-server-license-terms'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now codium-web.service
exit
```

## 4. Publish the IDE

Your editor is now running privately on port `8080` inside the container. Let's publish it to the web.

On the Terrarium host, run:
```bash
lxc config set devbox user.proxy "https://code.example.com:8080"
terrariumctl proxy sync
```

Terrarium will automatically grab an SSL certificate and route `code.example.com` to your new web IDE.

## 5. How to Log In

When you visit your new URL, VSCodium will ask for your Connection Token. 

To view your token, run this command on your Terrarium host:
```bash
lxc exec devbox -- cat /etc/codium-web/token
```

Copy that long string, paste it into the browser, and log into your new cloud development environment.

*(Tip: To reset your password, run that `openssl rand -hex 32 > /etc/codium-web/token` command again inside the container and restart the service.)*