# terrariumctl

`terrariumctl` is the main Terrarium control surface. It handles install, status, reconfiguration, proxy sync, IDP sync, backup export, and restore.

## Top-Level Commands

| Command | Arguments | Defaults | Meaning |
| --- | --- | --- | --- |
| `terrariumctl install` | optional flags, see below | interactive mode | Installs or bootstraps Terrarium on the current host, including preflight verification for external OIDC and S3 when enabled. |
| `terrariumctl status` | none | n/a | Shows Terrarium service status, management endpoints, IDP mode, admin group, and the oauth2-proxy state. |
| `terrariumctl backup list` | none | n/a | Lists local ZFS snapshots and, when enabled, S3 manifests. |
| `terrariumctl backup export` | none | n/a | Uploads the current incremental ZFS backup chain to configured S3 storage. |
| `terrariumctl backup restore` | required: `--instance`; optional: `--source`, `--at`, `--as-new` | `--source local`, latest restore point, in-place restore | Restores an instance either in place by default or as a new instance when `--as-new` is provided. |
| `terrariumctl reconfigure` | none | n/a | Re-runs the local Ansible reconciliation using the persisted config. |
| `terrariumctl proxy sync` | none | n/a | Rebuilds Traefik dynamic config and Terrarium-managed UFW rules from LXC `user.proxy` labels. |
| `terrariumctl mount add` | required: `protocol`, `hostPath`, `address`, `username`; optional: `-p/--password`, `--seal` | password prompt, `uid=0`, `gid=0`, `file_mode=0660`, `dir_mode=0770`, `--seal=true` | Creates a managed host SMB/CIFS mount, stores credentials under `/etc/terrarium/mounts`, writes a managed `/etc/fstab` block, and mounts it immediately. |
| `terrariumctl mount remove` | required: `hostPath` | n/a | Unmounts a Terrarium-managed host mount, removes its managed `/etc/fstab` block, and deletes its managed credentials file. |
| `terrariumctl mount list` | none | n/a | Lists Terrarium-managed host mounts, including whether each one is currently mounted. |
| `terrariumctl idp sync` | none | n/a | Reconciles self-hosted ZITADEL applications, Terrarium management role claims, and related local OIDC settings. No-op unless ZITADEL mode is enabled. |
| `terrariumctl set domains` | optional `rootDomain`, plus override flags | `manage.<rootDomain>`, `lxd.<rootDomain>`, `auth.<rootDomain>` when applicable | Updates the root domain, derived Terrarium subdomains, re-verifies external OIDC when needed, and re-runs reconciliation. |
| `terrariumctl set emails` | optional flags | existing values when omitted | Updates Terrarium contact, ACME, and ZITADEL admin emails. |
| `terrariumctl set idp local|oidc` | mode plus optional flags | n/a | Switches between self-hosted ZITADEL and external OIDC, verifies external OIDC settings when applicable, and reconfigures oauth2-proxy plus LXD management auth together. |
| `terrariumctl set s3` | optional flags | keeps current enable/disable state unless `--enable` or `--disable` is passed | Updates S3 backup settings, verifies the target with a real test operation, and can enable or disable S3 exports. |
| `terrariumctl set syncoid` | optional flags | keeps current enable/disable state unless `--enable` or `--disable` is passed | Updates syncoid replication settings and can enable or disable syncoid. |

## install

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--non-interactive` | none | no | interactive mode if omitted | Disables prompts and requires all needed config through flags. |
| `--yes` | none | no | prompt before destructive actions | Auto-confirms destructive or confirmation prompts. |
| `--ref` | git branch or tag | no | `main` | Checks out a specific Terrarium ref in `/opt/terrarium`. |
| `--email` | email address | yes in non-interactive mode; no in interactive mode | prompted in interactive mode | Sets the Terrarium contact/admin email and default ZITADEL bootstrap admin email. |
| `--acme-email` | email address | no | falls back to `--email` | Sets the ACME account identity for Traefik and LXD certificate automation. |
| `--domain` | root domain | no | service domains default to `<service>.<dashed-public-ip>.traefik.me` when omitted | Sets the root domain used to derive service subdomains. |
| `--manage-domain` | domain | no | `manage.<domain>` when `--domain` is set, otherwise `manage.<dashed-public-ip>.traefik.me` | Overrides the Cockpit domain. |
| `--proxy-domain` | domain | no | `proxy.<domain>` when `--domain` is set, otherwise `proxy.<dashed-public-ip>.traefik.me` | Overrides the Traefik dashboard domain. |
| `--lxd-domain` | domain | no | `lxd.<domain>` when `--domain` is set, otherwise `lxd.<dashed-public-ip>.traefik.me` | Overrides the LXD domain. |
| `--idp` | `local` or `oidc` | yes in non-interactive mode; no in interactive mode | prompted in interactive mode | Selects whether Terrarium uses self-hosted ZITADEL or an external OIDC issuer. |
| `--admin-group` | group name | yes when `--idp=oidc`; no otherwise | `terrarium-admins` when `--idp=local`, otherwise prompted in interactive mode | Sets the management admin group that is allowed into Cockpit and LXD. |
| `--oidc` | issuer URL | yes when `--idp=oidc`; no otherwise | derived from `https://<auth-domain>` when `--idp=local` | Sets the OIDC issuer URL. |
| `--oidc-client` | client ID | yes when `--idp=oidc`; no otherwise | none | Sets the external OIDC client ID used by Cockpit's oauth2-proxy and LXD. |
| `--oidc-secret` | client secret | yes when `--idp=oidc`; no otherwise | none | Sets the external OIDC client secret used by Cockpit's oauth2-proxy and LXD. |
| `--auth-domain` | domain | no | `auth.<domain>` when `--domain` is set and self-hosted ZITADEL is enabled, otherwise `auth.<dashed-public-ip>.traefik.me` | Overrides the ZITADEL auth domain. |
| `--zitadel-admin-email` | email address | no | falls back to `--email` | Sets the initial admin email for self-hosted ZITADEL. |
| `--root-pwd` | password | yes in non-interactive mode when root has no usable local password; no otherwise | existing root password if already set, otherwise prompted in interactive mode | Sets or updates the root password used for Cockpit login. |
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

Install verification notes:

- In interactive mode, external OIDC is not accepted until Terrarium can reach the issuer, confirm the callback flow looks valid, and probe the client credentials.
- In interactive mode, S3 is not accepted until Terrarium can reach the bucket and complete a write/delete verification object cycle.
- In non-interactive mode, the same checks run once and the install exits on failure.
| `--enable-syncoid` | none | no | disabled | Enables syncoid replication to a second ZFS host. |
| `--syncoid-target` | host | yes if `--enable-syncoid` is set | none | Sets the remote SSH target for syncoid replication. |
| `--syncoid-target-dataset` | dataset | yes if `--enable-syncoid` is set | `backup/terrarium` in interactive prompts | Sets the remote target dataset for syncoid replication. |
| `--syncoid-ssh-key` | path | yes if `--enable-syncoid` is set | `/root/.ssh/id_ed25519` in interactive prompts | Sets the SSH key used for syncoid replication. |

## backup restore

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--source` | `local` or `s3` | no | `local` | Chooses whether restore data comes from local ZFS snapshots or from S3 manifests and streams. |
| `--instance` | instance name | yes | none | Names the source instance to restore from. |
| `--at` | snapshot fragment or timestamp | no | latest local snapshot or latest S3 manifest chain | Selects the restore point to match. |
| `--as-new` | new instance name | no | in-place restore | Restores into a new dataset and then hands off into interactive `lxd recover`. |

Restore behavior:

- `terrariumctl backup restore --instance NAME` restores from the latest local snapshot in place by default after confirmation.
- `terrariumctl backup restore --source local|s3 --instance NAME [--at ...] --as-new NEWNAME` restores the chosen point and then launches interactive `lxd recover`.

## mount add

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| positional `protocol` | `smb` or `cifs` | yes | none | Chooses the SMB/CIFS mount handler. Both values map to a managed CIFS mount. |
| positional `hostPath` | absolute host path | yes | none | The mount point to create on the Terrarium host. |
| positional `address` | share address | yes | none | The SMB share address, usually `//server/share`. |
| positional `username` | username | yes | none | The SMB/CIFS username written to the managed credentials file. |
| `-p`, `--password` | password | no | prompt if omitted | The SMB/CIFS password. Omit it to let Terrarium prompt securely instead of putting it in shell history. |
| `--uid` | uid | no | `0` | UID presented for files on the mounted share. |
| `--gid` | gid | no | `0` | GID presented for files on the mounted share. |
| `--file-mode` | octal mode | no | `0660` | File permissions presented on the mounted share. |
| `--dir-mode` | octal mode | no | `0770` | Directory permissions presented on the mounted share. |
| `--seal` | `true` or `false` | no | `true` | Enables or disables the SMB encryption option explicitly. |

Example:

```bash
terrariumctl mount add cifs /srv/shared/storage-box //u12345.your-storagebox.de/backup u12345
```

Behavior:

- Terrarium creates the mount point if it does not exist.
- Terrarium writes credentials under `/etc/terrarium/mounts/`.
- Terrarium adds or updates a Terrarium-managed block in `/etc/fstab`.
- If the path is already mounted, Terrarium remounts it cleanly.

## mount remove

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| positional `hostPath` | absolute host path | yes | none | The Terrarium-managed mount point to remove from the host. |

Example:

```bash
terrariumctl mount remove /srv/shared/storage-box
```

Behavior:

- Terrarium unmounts the path if it is currently mounted.
- Terrarium removes the managed block from `/etc/fstab`.
- Terrarium deletes the managed credentials file for that mount.

## mount list

Example:

```bash
terrariumctl mount list
```

Behavior:

- Shows all Terrarium-managed mounts discovered in `/etc/fstab`.
- Reports the share address, host path, protocol, and whether the path is mounted right now.

## set domains

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| positional `rootDomain` | domain | no | prompted when omitted | Sets the new root domain. |
| `--manage-domain` | domain | no | `manage.<rootDomain>` | Overrides the Cockpit domain. |
| `--proxy-domain` | domain | no | `proxy.<rootDomain>` | Overrides the Traefik dashboard domain. |
| `--lxd-domain` | domain | no | `lxd.<rootDomain>` | Overrides the LXD domain. |
| `--auth-domain` | domain | no | `auth.<rootDomain>` when self-hosted ZITADEL is enabled | Overrides the ZITADEL domain. |

## set emails

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--email` | email address | no | existing configured value | Updates the Terrarium contact/admin email. |
| `--acme-email` | email address | no | existing configured value or falls back to `--email` | Updates the ACME account email. |
| `--zitadel-admin-email` | email address | no | existing configured value or falls back to `--email` | Updates the self-hosted ZITADEL bootstrap admin email. |

## set idp

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| positional mode | `local` or `oidc` | yes | none | Switches the Terrarium IDP mode. |
| `--auth-domain` | domain | no | derived from the current root domain or IP when mode is `local` | Overrides the self-hosted ZITADEL auth domain. |
| `--admin-group` | group name | required when mode is `oidc`; optional otherwise | existing configured value, or `terrarium-admins` when mode is `local` | Sets the management admin group for Cockpit and LXD authorization. |
| `--oidc` | issuer URL | required when mode is `oidc` and no issuer is already configured | existing configured issuer, or derived from `auth-domain` when mode is `local` | Sets the OIDC issuer URL. |
| `--oidc-client` | client ID | required when mode is `oidc` and no client ID is already configured | existing configured value | Sets the external OIDC client ID shared by Cockpit's oauth2-proxy and LXD. |
| `--oidc-secret` | client secret | required when mode is `oidc` and no client secret is already configured | existing configured value | Sets the external OIDC client secret shared by Cockpit's oauth2-proxy and LXD. |
| `--zitadel-admin-email` | email address | no | existing configured value or `--email` | Updates the ZITADEL bootstrap admin email when mode is `local`. |

External OIDC notes:

- Terrarium configures both Cockpit's oauth2-proxy and LXD from the same external issuer and client settings.
- The external client must allow:
  - `https://<manage-domain>/oauth2/callback`
  - `https://<lxd-domain>/oidc/callback`
- The external provider must emit a `groups` claim that contains the configured admin group as a JSON string array.
- `terrariumctl set idp oidc ...` verifies the issuer, callback flow, and client credentials before persisting the new settings.

Local ZITADEL notes:

- Terrarium auto-provisions a management role named after `terrarium_admin_group`, defaulting to `terrarium-admins`.
- The bootstrap admin is granted that role automatically.
- Terrarium also installs a small ZITADEL Action that flattens Terrarium role assignments into a `groups` claim for oauth2-proxy and LXD.

## set s3

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

S3 verification notes:

- When S3 is enabled or updated, Terrarium verifies the target bucket with a real write/delete probe.
- This catches wrong endpoint, wrong credentials, wrong bucket, and missing write permissions before backup settings are persisted.

## set syncoid

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--enable` | none | no | keeps current state | Enables syncoid replication. |
| `--disable` | none | no | keeps current state | Disables syncoid replication. |
| `--syncoid-target` | host | required when syncoid is enabled | existing configured value | Updates the remote syncoid SSH target. |
| `--syncoid-target-dataset` | dataset | required when syncoid is enabled | existing configured value | Updates the remote syncoid dataset. |
| `--syncoid-ssh-key` | path | no | existing configured value or `/root/.ssh/id_ed25519` | Updates the SSH key used by syncoid. |
