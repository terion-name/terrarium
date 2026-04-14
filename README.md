# Terrarium

Terrarium bootstraps a single Ubuntu 24.04 VPS into a ZFS-backed LXD host for isolated workloads.

The intended entrypoint is:

```bash
curl -fsSL https://raw.githubusercontent.com/terion-name/terrarium/refs/heads/main/install.sh | bash
```

The shell bootstrap is intentionally thin. It downloads a compiled `terrariumctl` bundle from GitHub Releases when possible, clones the Terrarium repo into `/opt/terrarium`, stages the bundled binary into that checkout, and falls back to a source build only when you target a branch-like `--ref` such as `main`.

Terrarium provisions the host with:

- Cockpit
- `45Drives/cockpit-zfs`
- `45Drives/cockpit-S3ObjectBroswer`
- LXD with the built-in web UI
- ZFS
- `sanoid` and optional `syncoid`
- Traefik for public management endpoints
- Optional self-hosted ZITADEL at `auth.<domain>`
- `devsec.hardening` OS and SSH hardening

## Supported Host

- Ubuntu Server 24.04 LTS
- Single-host install only
- LXC containers only

## Install Modes

Interactive:

```bash
curl -fsSL https://raw.githubusercontent.com/terion-name/terrarium/refs/heads/main/install.sh | bash -s -- --interactive
```

Non-interactive:

```bash
curl -fsSL https://raw.githubusercontent.com/terion-name/terrarium/refs/heads/main/install.sh | bash -s -- \
  --non-interactive \
  --email admin@your-domain.tld \
  --idp-mode zitadel-self-hosted \
  --storage-mode loop \
  --yes
```

## Storage Strategy

Recommended:

- Attach a dedicated block volume and use `--storage-mode disk`.

Fallback:

- If the VPS only has the default root disk, Terrarium can create a file-backed ZFS pool with `--storage-mode loop`.

Partition mode:

- `--storage-mode partition` is intended for an existing safe partition target or a non-root whole disk that Terrarium can partition.
- Terrarium does not try to shrink the mounted root filesystem.

## Public Endpoints

By default, Terrarium exposes:

- `https://manage.<dashed-public-ip>.traefik.me` for Cockpit
- `https://lxd.<dashed-public-ip>.traefik.me` for the LXD API and UI
- `https://auth.<dashed-public-ip>.traefik.me` for self-hosted ZITADEL when `--idp-mode zitadel-self-hosted` is enabled

You can override the domains with:

- `--domain`
- `--manage-domain`
- `--lxd-domain`
- `--auth-domain`

## Reconfiguration

The installer keeps the checked out repository at `/opt/terrarium` and writes the resolved config to `/etc/terrarium/config.yaml`.

After installation:

```bash
terrariumctl status
terrariumctl backup list
terrariumctl backup export
terrariumctl backup restore --source s3 --instance app --at 2026-04-12T12 --as-new app-restore
terrariumctl reconfigure
terrariumctl proxy sync
terrariumctl idp sync
terrariumctl setdomain example.com
```

`terrariumctl setdomain` updates the persisted root domain, derives `manage.`, `lxd.`, and `auth.` subdomains unless you override them, and then re-runs the full Ansible reconciliation so Traefik, LXD, and ZITADEL pick up the new external hostnames.

When self-hosted ZITADEL is enabled, Terrarium generates the initial admin password at `/etc/terrarium/secrets/zitadel_admin_password`.

## LXC Proxy Labels

Terrarium can sync LXC `user.proxy` labels into Traefik every minute.

Examples:

```bash
lxc config set my-app user.proxy "https://app.example.com:3000,http://app-insecure.example.com:3000"
lxc config set game user.proxy "tcp://25565:25565,udp://19132:19132"
```

Rules:

- `https://domain[:container_port][/path]` creates HTTP-to-HTTPS redirect plus a TLS router.
- `http://domain[:container_port][/path]` creates an HTTP router only.
- `tcp://hostport:containerport` exposes a raw TCP port through Traefik.
- `udp://hostport:containerport` exposes a raw UDP port through Traefik.
- Dynamic TCP/UDP host ports are also opened and closed in UFW automatically by the sync job.
- If the container does not have a global IPv4 address yet, the route is skipped until it does.

## Development

Validate locally:

```bash
bun install
bun run build
bash -n install.sh
ansible-playbook -i ansible/inventory.ini ansible/site.yml --syntax-check
```
