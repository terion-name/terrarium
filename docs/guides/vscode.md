# VSCodium Web IDE on Terrarium

For Terrarium, the right browser-IDE story is `VSCodium`, not Microsoft's branded VS Code and not legacy `code-server`.

That matters for two reasons:

- VSCodium uses the open extension ecosystem by default instead of Microsoft's marketplace restrictions.
- `codium serve-web` gives you a first-party web mode that fits Terrarium's reverse-proxy model cleanly.

If your goal is "a browser editor on my own domain, inside a time-machine-enabled LXC, with open marketplace behavior", this is the guide you want.

## Why Terrarium fits this use case

- Security: the editor, extensions, terminals, runtimes, and project files live inside the container.
- Isolation: each project or team can have its own fully separate devbox.
- Time machine: if an extension, SDK, or shell experiment breaks the environment, you can step the container back to a known-good state.
- Networking: `codium serve-web` is a normal web service, so Terrarium can publish it through Traefik with `user.proxy`.

## Create the container

You can do this either in the shipped LXD UI or from the CLI.

In the LXD UI:

1. Open `https://lxd.<your-domain>` and log in.
2. Create a new instance from the `images:ubuntu/24.04` image.
3. Name it `devbox` or `codium`.
4. Start the container.

From the CLI:

```bash
lxc launch images:ubuntu/24.04 devbox
```

## Recommended setup: enter the container and configure it there

Open a shell in the container:

```bash
lxc exec devbox -- bash
```

Install the VSCodium apt repository exactly as the official VSCodium install docs describe for Ubuntu/Debian:

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

Generate a connection token for the web UI:

```bash
install -d -m 0700 /etc/codium-web
openssl rand -hex 32 > /etc/codium-web/token
chmod 600 /etc/codium-web/token
```

Create a systemd unit for `codium serve-web`:

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
```

Check that it is running:

```bash
systemctl status codium-web.service --no-pager
```

## Publish it through Terrarium

Leave the container shell, then publish it from the host:

```bash
lxc config set devbox user.proxy "https://code.example.com:8080"
terrariumctl proxy sync
```

That gives you:

- `codium serve-web` listening on `0.0.0.0:8080` inside the container
- TLS and hostname routing handled by Traefik on the Terrarium host
- connection-token protection still handled by the VSCodium web server itself

## How to log in

When you first open the IDE at `https://code.example.com`, VSCodium will require the connection token.

Show the token from inside the container:

```bash
lxc exec devbox -- cat /etc/codium-web/token
```

You can keep using that token, or rotate it at any time:

```bash
lxc exec devbox -- bash -lc 'openssl rand -hex 32 > /etc/codium-web/token && chmod 600 /etc/codium-web/token && systemctl restart codium-web.service'
```

## About `--without-connection-token`

You can run `codium serve-web --without-connection-token`, and that is the flag pattern you sometimes see in examples, but the upstream CLI help explicitly says to use that only when the connection is secured by other means.

Terrarium gives you TLS and routing, but not browser auth on that route by default, so the safer default is to keep the connection token enabled.

If you later place the route behind a real auth layer, then dropping the token can make sense.

## Automation version

If you want the same setup as a condensed host-side sequence, use:

```bash
lxc launch images:ubuntu/24.04 devbox
lxc exec devbox -- bash -lc 'apt-get update && apt-get install -y wget gpg apt-transport-https openssl'
lxc exec devbox -- bash -lc 'wget https://gitlab.com/paulcarroty/vscodium-deb-rpm-repo/raw/master/pub.gpg -O /usr/share/keyrings/vscodium-archive-keyring.asc'
lxc exec devbox -- bash -lc "echo 'deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/vscodium-archive-keyring.asc ] https://paulcarroty.gitlab.io/vscodium-deb-rpm-repo/debs vscodium main' > /etc/apt/sources.list.d/vscodium.list"
lxc exec devbox -- bash -lc 'apt-get update && apt-get install -y codium'
lxc exec devbox -- bash -lc 'install -d -m 0700 /etc/codium-web && openssl rand -hex 32 > /etc/codium-web/token && chmod 600 /etc/codium-web/token'
lxc exec devbox -- bash -lc "cat > /etc/systemd/system/codium-web.service <<'EOF'
[Unit]
Description=VSCodium Web Server
After=network.target

[Service]
User=root
Group=root
WorkingDirectory=/root
ExecStart=/bin/bash -lc '/usr/bin/codium serve-web --host 0.0.0.0 --port 8080 --connection-token \"\$(cat /etc/codium-web/token)\" --accept-server-license-terms'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now codium-web.service"
lxc config set devbox user.proxy "https://code.example.com:8080"
terrariumctl proxy sync
```

## Recommended workflow

1. Put one project, team, or customer workspace in one container.
2. Install the runtimes and extensions that belong only to that environment.
3. Snapshot before large dependency or extension changes.
4. Expose the IDE only after `codium-web.service` is healthy and the connection token is recorded somewhere safe.

This is one of the nicest Terrarium patterns in practice: each devbox feels like a real machine, but the blast radius stays contained and the time machine is there when an experiment goes wrong.

## Upstream docs used for this guide

- [VSCodium README and install docs](https://github.com/VSCodium/vscodium)
- [VSCodium Debian/Ubuntu repository instructions](https://gitlab.com/paulcarroty/vscodium-deb-rpm-repo/-/raw/master/README.md)
- [VS Code CLI `serve-web` options and security note](https://github.com/microsoft/vscode/issues/192230)

Inference note: VSCodium is built from the VS Code codebase and carries the same CLI surface, so the `serve-web` flags documented in the upstream VS Code CLI also apply to `codium`.
