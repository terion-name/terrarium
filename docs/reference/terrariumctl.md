# terrariumctl

`terrariumctl` is the main Terrarium control surface. It handles install, status, reconfiguration, proxy sync, IDP sync, backup export, and restore.

## Top-Level Commands

| Command | Arguments | Defaults | Meaning |
| --- | --- | --- | --- |
| `terrariumctl install` | optional flags, see below | interactive mode | Installs or bootstraps Terrarium on the current host. |
| `terrariumctl status` | none | n/a | Shows Terrarium service status, management endpoints, IDP mode, admin group, and the oauth2-proxy state. |
| `terrariumctl backup list` | none | n/a | Lists local ZFS snapshots and, when enabled, S3 manifests. |
| `terrariumctl backup export` | none | n/a | Uploads the current incremental ZFS backup chain to configured S3 storage. |
| `terrariumctl backup restore` | required: `--instance`; optional: `--source`, `--at`, `--as-new` | `--source local`, latest restore point, in-place restore | Restores an instance either in place by default or as a new instance when `--as-new` is provided. |
| `terrariumctl reconfigure` | none | n/a | Re-runs the local Ansible reconciliation using the persisted config. |
| `terrariumctl proxy sync` | none | n/a | Rebuilds Traefik dynamic config and Terrarium-managed UFW rules from LXC `user.proxy` labels. |
| `terrariumctl idp sync` | none | n/a | Reconciles self-hosted ZITADEL applications, Terrarium management role claims, and related local OIDC settings. No-op unless ZITADEL mode is enabled. |
| `terrariumctl set domains` | optional `rootDomain`, plus override flags | `manage.<rootDomain>`, `lxd.<rootDomain>`, `auth.<rootDomain>` when applicable | Updates the root domain, derived Terrarium subdomains, and re-runs reconciliation. |
| `terrariumctl set emails` | optional flags | existing values when omitted | Updates Terrarium contact, ACME, and ZITADEL admin emails. |
| `terrariumctl set idp local|oidc` | mode plus optional flags | n/a | Switches between self-hosted ZITADEL and external OIDC, and reconfigures oauth2-proxy plus LXD management auth together. |
| `terrariumctl set s3` | optional flags | keeps current enable/disable state unless `--enable` or `--disable` is passed | Updates S3 backup settings and can enable or disable S3 exports. |
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

## set domains

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| positional `rootDomain` | domain | no | prompted when omitted | Sets the new root domain. |
| `--manage-domain` | domain | no | `manage.<rootDomain>` | Overrides the Cockpit domain. |
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

## set syncoid

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--enable` | none | no | keeps current state | Enables syncoid replication. |
| `--disable` | none | no | keeps current state | Disables syncoid replication. |
| `--syncoid-target` | host | required when syncoid is enabled | existing configured value | Updates the remote syncoid SSH target. |
| `--syncoid-target-dataset` | dataset | required when syncoid is enabled | existing configured value | Updates the remote syncoid dataset. |
| `--syncoid-ssh-key` | path | no | existing configured value or `/root/.ssh/id_ed25519` | Updates the SSH key used by syncoid. |
