# Terrarium

<p align="center">
    <picture>
        <img src="https://raw.githubusercontent.com/terion-name/terrarium/main/assets/banner.webp" alt="Terrarium" width="100%" style="max-width: 800px">
    </picture>
</p>

Terrarium turns a plain Ubuntu 24.04 VPS into something much more useful: a secure, rewindable home for isolated environments. It is designed for the way people actually work with agents and development tools today, where giving software real freedom is powerful, but giving it unlimited freedom on your host is a bad idea.

If you want to run agent systems like OpenClaw, Hermes, or other tools that need full shell access, custom packages, background services, and room to experiment, Terrarium gives them their own LXD containers on ZFS. That means they can operate inside real environments instead of cramped Docker setups, while the host stays hardened and recoverable. When an agent makes a mess, installs the wrong thing, or mutates a system beyond recognition, you can rewind the container state in small steps instead of rebuilding everything from scratch.

Terrarium is just as useful for human workflows. You can spin up development environments, temporary sandboxes, internal tools, or web-based apps like browser-accessible editors and agent UIs, then expose them through Traefik with automatic proxying and TLS. Each environment stays isolated, configurable, and easy to back up, so you get the flexibility of a full VPS without turning the whole server into a shared blast radius.

The goal is simple: make a single VPS feel safe enough for experimentation, capable enough for real work, and forgiving enough that you can move fast without being one bad command away from starting over.


## Install:

```bash
curl -fsSL https://github.com/terion-name/terrarium/releases/latest/download/install.sh | bash
```

The shell bootstrap is intentionally thin. The release-published `install.sh` is pinned to the release it came from, downloads the matching compiled `terrariumctl` bundle from GitHub Releases, clones the Terrarium repo into `/opt/terrarium`, and stages that binary into the checkout. If you explicitly target a branch-like `--ref` such as `main`, it falls back to a source build.

If you want to pin a specific release instead of `latest`, use the tagged release asset directly:

```bash
curl -fsSL https://github.com/terion-name/terrarium/releases/download/0.0.0-beta1/install.sh | bash
```

Terrarium provisions the host with:

- Cockpit
- `45Drives/cockpit-zfs`
- `45Drives/cockpit-S3ObjectBroswer`
- LXD with the built-in web UI
- ZFS
- `sanoid` and optional `syncoid`
- Traefik for public management endpoints
- Optional self-hosted ZITADEL at `auth.<domain>`
- External OIDC issuer support when you do not want to self-host the IDP
- `devsec.hardening` OS and SSH hardening

## Supported Host

- Ubuntu Server 24.04 LTS
- Single-host install only
- LXC containers only

## Install Modes

Interactive:

```bash
curl -fsSL https://github.com/terion-name/terrarium/releases/latest/download/install.sh | bash
```

Non-interactive:

```bash
curl -fsSL https://github.com/terion-name/terrarium/releases/latest/download/install.sh | bash -s -- \
  --non-interactive \
  --email admin@your-domain.tld \
  --acme-email certs@your-domain.tld \
  --idp local \
  --storage-mode file \
  --yes
```

## Storage Strategy

Recommended:

- Attach a dedicated block volume and use `--storage-mode disk`.

Fallback:

- If the VPS only has the default root disk, Terrarium can create a file-backed ZFS pool with `--storage-mode file`.

Partition mode:

- `--storage-mode partition` is intended for an existing unused partition or allocatable free space on a non-root disk.
- In interactive mode, Terrarium discovers allocatable partition targets, suggests the largest one, and asks for confirmation.
- In non-interactive mode, `--storage-source` is required for `disk` and `partition` mode. Use `--storage-source auto` to let Terrarium pick the largest valid target automatically.
- Terrarium does not try to shrink the mounted root filesystem.

## Public Endpoints

By default, Terrarium exposes:

- `https://manage.<dashed-public-ip>.traefik.me` for Cockpit
- `https://lxd.<dashed-public-ip>.traefik.me` for the LXD API and UI
- `https://auth.<dashed-public-ip>.traefik.me` for self-hosted ZITADEL when `--idp=local` is enabled

You can override the domains with:

- `--domain`
- `--manage-domain`
- `--lxd-domain`
- `--auth-domain`

Email settings:

- `--email` sets the Terrarium contact/admin email and is used as the default ZITADEL bootstrap admin email.
- `--acme-email` sets the ACME account identity used by Traefik and LXD certificate automation.
- If `--acme-email` is omitted, Terrarium falls back to `--email`.

## Reconfiguration

The installer keeps the checked out repository at `/opt/terrarium` and writes the resolved config to `/etc/terrarium/config.yaml`.

Changing settings through `terrariumctl set ...` always rewrites `/etc/terrarium/config.yaml` and re-runs the local Ansible reconciliation.

What gets updated on change:

- Traefik config changes trigger a Traefik restart.
- LXD domain, ACME, and OIDC settings are applied directly through `lxc config set`; they do not require a full LXD restart.
- Self-hosted ZITADEL is enabled, disabled, or restarted when its compose or Terraform-rendered config changes.
- Terrarium then re-runs `terrariumctl proxy sync`, and when IDP mode is `local`, also re-runs `terrariumctl idp sync`.

## terrariumctl Reference

Top-level commands:

| Command | Arguments | Defaults | Meaning |
| --- | --- | --- | --- |
| `terrariumctl install` | optional flags, see below | interactive mode | Installs or bootstraps Terrarium on the current host. |
| `terrariumctl status` | none | n/a | Shows Terrarium service status and the main service endpoints detected from config. |
| `terrariumctl backup list` | none | n/a | Lists local ZFS snapshots and, when enabled, S3 manifests. |
| `terrariumctl backup export` | none | n/a | Uploads the current incremental ZFS backup chain to configured S3 storage. |
| `terrariumctl backup restore` | required: `--instance`; optional: `--source`, `--at`, `--as-new` | `--source local`, latest restore point, in-place restore | Restores an instance either in place by default or as a new instance when `--as-new` is provided. |
| `terrariumctl reconfigure` | none | n/a | Re-runs the local Ansible reconciliation using the persisted config. |
| `terrariumctl proxy sync` | none | n/a | Rebuilds Traefik dynamic config and Terrarium-managed UFW rules from LXC `user.proxy` labels. |
| `terrariumctl idp sync` | none | n/a | Reconciles self-hosted ZITADEL clients and related OIDC settings. No-op unless ZITADEL mode is enabled. |
| `terrariumctl set domains` | optional `rootDomain`, plus override flags | `manage.<rootDomain>`, `lxd.<rootDomain>`, `auth.<rootDomain>` when applicable | Updates the root domain, derived Terrarium subdomains, and re-runs reconciliation. |
| `terrariumctl set emails` | optional flags | existing values when omitted | Updates Terrarium contact, ACME, and ZITADEL admin emails. |
| `terrariumctl set idp local|oidc` | mode plus optional flags | n/a | Switches between self-hosted ZITADEL and external OIDC, and updates related settings. |
| `terrariumctl set s3` | optional flags | keeps current enable/disable state unless `--enable` or `--disable` is passed | Updates S3 backup settings and can enable or disable S3 exports. |
| `terrariumctl set syncoid` | optional flags | keeps current enable/disable state unless `--enable` or `--disable` is passed | Updates syncoid replication settings and can enable or disable syncoid. |

`terrariumctl install` options:

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--non-interactive` | none | no | interactive mode if omitted | Disables prompts and requires all needed config through flags. |
| `--yes` | none | no | prompt before destructive actions | Auto-confirms destructive or confirmation prompts. |
| `--ref` | git branch or tag | no | `main` | Checks out a specific Terrarium ref in `/opt/terrarium`. |
| `--email` | email address | yes in non-interactive mode; no in interactive mode | prompted in interactive mode | Sets the Terrarium contact/admin email and default ZITADEL bootstrap admin email. |
| `--acme-email` | email address | no | falls back to `--email` | Sets the ACME account identity for Traefik and LXD certificate automation. |
| `--domain` | root domain | no | service domains default to `<service>.<dashed-public-ip>.traefik.me` when omitted | Sets the root domain used to derive service subdomains. |
| `--manage-domain` | domain | no | `manage.<domain>` when `--domain` is set, otherwise `manage.<dashed-public-ip>.traefik.me` | Overrides the Cockpit domain. |
| `--lxd-domain` | domain | no | `lxd.<domain>` when `--domain` is set, otherwise `lxd.<dashed-public-ip>.traefik.me` | Overrides the LXD domain. |
| `--idp` | `local` or `oidc` | yes in non-interactive mode; no in interactive mode | prompted in interactive mode | Selects whether Terrarium uses self-hosted ZITADEL (`local`) or an external OIDC issuer (`oidc`). |
| `--oidc` | issuer URL | yes when `--idp=oidc`; no otherwise | derived from `https://<auth-domain>` when `--idp=local` | Sets the OIDC issuer URL. |
| `--oidc-client` | client ID | yes when `--idp=oidc`; no otherwise | none | Sets the external OIDC client ID. |
| `--oidc-secret` | client secret | yes when `--idp=oidc`; no otherwise | none | Sets the external OIDC client secret. |
| `--auth-domain` | domain | no | `auth.<domain>` when `--domain` is set and self-hosted ZITADEL is enabled, otherwise `auth.<dashed-public-ip>.traefik.me` | Overrides the ZITADEL auth domain. |
| `--zitadel-admin-email` | email address | no | falls back to `--email` | Sets the initial admin email for self-hosted ZITADEL. |
| `--storage-mode` | `disk`, `partition`, or `file` | yes in non-interactive mode; no in interactive mode | prompted or auto-selected in interactive mode | Selects how the LXD ZFS pool is created. |
| `--storage-source` | path or `auto` | yes for `disk` and `partition` in non-interactive installs; no in interactive mode | prompted when needed in interactive mode | Sets the source disk or partition for `disk` or `partition` mode, or uses `auto` to pick the largest valid target. |
| `--storage-size` | size string | only for `file` mode when overriding the default | `64G` in interactive prompts and non-interactive fallback | Sets the size of the file-backed ZFS pool for `file` mode. |
| `--enable-s3` | none | no | disabled | Enables S3-backed archive exports. |
| `--s3-endpoint` | URL | only when using a custom S3-compatible provider | `https://s3.amazonaws.com` in interactive prompts; otherwise provider/default SDK behavior | Sets a custom S3-compatible API endpoint. |
| `--s3-bucket` | bucket name | yes if `--enable-s3` is set | none | Sets the destination bucket for S3 exports. |
| `--s3-region` | region name | no | provider default or empty | Sets the S3 region. |
| `--s3-prefix` | prefix | no | `terrarium` | Sets the object prefix under the bucket. |
| `--s3-access-key` | access key | yes if `--enable-s3` is set | none | Sets the S3 access key. |
| `--s3-secret-key` | secret key | yes if `--enable-s3` is set | none | Sets the S3 secret key. |
| `--enable-syncoid` | none | no | disabled | Enables syncoid replication to a second ZFS host. |
| `--syncoid-target` | host | yes if `--enable-syncoid` is set | none | Sets the remote SSH target for syncoid replication. |
| `--syncoid-target-dataset` | dataset | yes if `--enable-syncoid` is set | `backup/terrarium` in interactive prompts | Sets the remote target dataset for syncoid replication. |
| `--syncoid-ssh-key` | path | yes if `--enable-syncoid` is set | `/root/.ssh/id_ed25519` in interactive prompts | Sets the SSH key used for syncoid replication. |

`terrariumctl backup restore` options:

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--source` | `local` or `s3` | no | `local` | Chooses whether restore data comes from local ZFS snapshots or from S3 manifests and streams. |
| `--instance` | instance name | yes | none | Names the source instance to restore from. |
| `--at` | snapshot fragment or timestamp | no | latest local snapshot or latest S3 manifest chain | Selects the restore point to match. |
| `--as-new` | new instance name | no | in-place restore | Restores into a new dataset and then hands off into interactive `lxd recover`. |

Restore behavior:

- `terrariumctl backup restore --instance NAME` restores from the latest local snapshot in place by default after confirmation. Terrarium stops the instance if needed, restores the dataset, and then tells you to start the instance again.
- `terrariumctl backup restore --source local|s3 --instance NAME [--at ...] --as-new NEWNAME` restores the chosen restore point, or the latest one if `--at` is omitted, prints a visible notice explaining what is about to happen, and then launches interactive `lxd recover` for you.
- For `--as-new`, the expected follow-up is:
  1. Terrarium starts `lxd recover`
  2. Select the reported storage pool
  3. Import the recovered volume as the new instance name
  4. Verify with `lxc list NEWNAME`

`terrariumctl set domains` options:

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| positional `rootDomain` | domain | no | prompted when omitted | Sets the new root domain. |
| `--manage-domain` | domain | no | `manage.<rootDomain>` | Overrides the Cockpit domain. |
| `--lxd-domain` | domain | no | `lxd.<rootDomain>` | Overrides the LXD domain. |
| `--auth-domain` | domain | no | `auth.<rootDomain>` when self-hosted ZITADEL is enabled | Overrides the ZITADEL domain. |

`terrariumctl set emails` options:

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--email` | email address | no | existing configured value | Updates the Terrarium contact/admin email. |
| `--acme-email` | email address | no | existing configured value or falls back to `--email` | Updates the ACME account email. |
| `--zitadel-admin-email` | email address | no | existing configured value or falls back to `--email` | Updates the self-hosted ZITADEL bootstrap admin email. |

`terrariumctl set idp` options:

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| positional mode | `local` or `oidc` | yes | none | Switches the Terrarium IDP mode. |
| `--auth-domain` | domain | no | derived from the current root domain or IP when mode is `local` | Overrides the self-hosted ZITADEL auth domain. |
| `--oidc` | issuer URL | required when mode is `oidc` and no issuer is already configured | existing configured issuer, or derived from `auth-domain` when mode is `local` | Sets the OIDC issuer URL. |
| `--oidc-client` | client ID | required when mode is `oidc` and no client ID is already configured | existing configured value | Sets the external OIDC client ID. |
| `--oidc-secret` | client secret | required when mode is `oidc` and no client secret is already configured | existing configured value | Sets the external OIDC client secret. |
| `--zitadel-admin-email` | email address | no | existing configured value or `--email` | Updates the ZITADEL bootstrap admin email when mode is `local`. |

External OIDC note:

- Terrarium auto-provisions OIDC clients only for self-hosted ZITADEL.
- When you use external OIDC, Terrarium persists the issuer URL, client ID, and client secret, and configures the base LXD OIDC settings from them.
- There is still no oauth2-proxy integration for Cockpit in this repo, so those external OIDC credentials are not yet consumed by a Cockpit auth proxy.
- `terrariumctl set idp oidc --oidc ... --oidc-client ... --oidc-secret ...` therefore reconfigures LXD and disables self-hosted ZITADEL, but it does not add OIDC login to Cockpit.

`terrariumctl set s3` options:

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--enable` | none | no | keeps current state | Enables S3 exports. |
| `--disable` | none | no | keeps current state | Disables S3 exports. |
| `--s3-endpoint` | URL | no | existing configured value | Updates the S3 endpoint. |
| `--s3-bucket` | bucket name | required when S3 is enabled | existing configured value | Updates the S3 bucket. |
| `--s3-region` | region name | no | existing configured value | Updates the S3 region. |
| `--s3-prefix` | prefix | no | existing configured value or `terrarium` | Updates the S3 object prefix. |
| `--s3-access-key` | access key | required when S3 is enabled | existing configured value | Updates the S3 access key. |
| `--s3-secret-key` | secret key | required when S3 is enabled | existing configured value | Updates the S3 secret key. |

`terrariumctl set syncoid` options:

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--enable` | none | no | keeps current state | Enables syncoid replication. |
| `--disable` | none | no | keeps current state | Disables syncoid replication. |
| `--syncoid-target` | host | required when syncoid is enabled | existing configured value | Updates the remote syncoid SSH target. |
| `--syncoid-target-dataset` | dataset | required when syncoid is enabled | existing configured value | Updates the remote syncoid dataset. |
| `--syncoid-ssh-key` | path | no | existing configured value or `/root/.ssh/id_ed25519` | Updates the SSH key used by syncoid. |


`terrariumctl set domains` updates the persisted root domain, derives `manage.`, `lxd.`, and `auth.` subdomains unless you override them, and then re-runs the full Ansible reconciliation so Traefik, LXD, and ZITADEL pick up the new external hostnames.

When self-hosted ZITADEL is enabled, Terrarium generates the initial admin password at `/etc/terrarium/secrets/zitadel_admin_password`.


## LXC Proxy Labels

Terrarium can sync LXC `user.proxy` labels into Traefik every minute.

Examples:

```bash
lxc config set my-app user.proxy "https://app.example.com:3000,http://app-insecure.example.com:3000"
lxc config set game user.proxy "tcp://25565:25565,udp://19132:19132"
```

Rules:

- `https://domain[:container_port][/path]` creates HTTP-to-HTTPS redirect plus a TLS router to a port in LXC container. If path is provided it will add prefix to upstream route.
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
