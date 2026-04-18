# Terrarium Architecture

Terrarium turns a single Ubuntu 24.04 host into a hardened control plane for isolated LXD container environments, with ZFS-backed rewind and optional off-host backup/export.

## Layers

Terrarium is split into four layers:

1. `install.sh`
   Thin bootstrap only. The release-published installer is pinned to its own release, downloads the matching compiled `terrariumctl` bundle from GitHub Releases, and falls back to a source build only for branch-like refs such as `main`.
2. `terrariumctl`
   Single Terrarium binary. It owns install-time prompting, config rendering, status and maintenance commands, backup/restore flows, proxy sync, IDP sync, and config updates through `terrariumctl set ...`.
3. Ansible
   Owns host provisioning and idempotent reconciliation. The Terrarium config is persisted at `/etc/terrarium/config.yaml`, then Ansible converges the host into that state.
4. Host helpers
   Systemd timers and services invoke `terrariumctl` subcommands for recurring host-side work such as Traefik proxy sync, S3 export, and optional syncoid replication.

## Bootstrap And Reconciliation

- `terrariumctl install` is interactive by default.
- Non-interactive installs require explicit flags for the critical choices such as IDP mode and storage mode.
- The installer clones or updates the Terrarium repo into `/opt/terrarium`, stages the compiled binary into that checkout, writes a temporary config payload, and invokes Ansible locally.
- The resolved long-lived configuration is stored in `/etc/terrarium/config.yaml`.
- Sensitive one-time values that should not live in the persisted config, such as a root password supplied for Cockpit login, are passed to Ansible through a temporary secrets file and then removed.
- Post-install changes are handled through `terrariumctl set domains`, `set emails`, `set idp`, `set s3`, and `set syncoid`, followed by a local reconciliation run.

## Control Plane

- Traefik is the only public web entrypoint.
- Cockpit listens on loopback and is reverse-proxied through Traefik.
- A host-level `oauth2-proxy` instance also listens on loopback and is published only through same-domain `/oauth2/*` routes on the Cockpit hostname.
- LXD listens on loopback and is exposed through Traefik TCP passthrough so LXD keeps control of its own API/UI auth model.
- Self-hosted ZITADEL, when enabled, is also published through Traefik.
- UFW defaults to deny incoming and allow outgoing. Terrarium explicitly opens only the expected public ports, then adds or removes dynamic TCP/UDP rules for container-level proxy exposure.

## Authentication Model

- SSH is hardened to key-based access; password SSH is disabled.
- Cockpit is now gated by host-level OIDC through Traefik `ForwardAuth` and `oauth2-proxy`.
- Only members of `terrarium_admin_group` are allowed through the OIDC gate for Cockpit and LXD management access.
- Cockpit still authenticates against the host's local PAM accounts after the OIDC gate, so `root` needs a usable local password for Cockpit login.
- If root does not already have one, Terrarium prompts for a password during interactive install or requires `--root-pwd` in non-interactive mode.
- IDP mode has two variants:
  - `local`: Terrarium deploys ZITADEL and derives the OIDC issuer from the Terrarium auth domain.
  - `oidc`: Terrarium uses an external OIDC issuer and stores the issuer URL plus client credentials.
- Terrarium persists `terrarium_admin_group`, defaulting to `terrarium-admins` in local mode.
- For self-hosted ZITADEL, Terrarium provisions the management role and a token-complement Action that emits a flat `groups` claim.
- For external OIDC, Terrarium expects the provider to emit a `groups` claim that contains `terrarium_admin_group`.
- LXD uses native OIDC plus IdP-group mappings to grant only the management group `admin` on `server`.

## Proxy Model

- A host-side sync job runs every minute and also on demand via `terrariumctl proxy sync`.
- It reads `lxc list -f json`, enriches instance state, and inspects each container’s `user.proxy` label.
- Supported label formats are:
  - `https://domain[:container_port][/path]`
  - `http://domain[:container_port][/path]`
  - `https://domain[:container_port][/path]@auth`
  - `https://domain[:container_port][/path]@auth:group1,group2`
  - `http://domain[:container_port][/path]@auth`
  - `http://domain[:container_port][/path]@auth:group1,group2`
  - `tcp://hostport:containerport`
  - `udp://hostport:containerport`
- The sync job renders Traefik dynamic config, extends static Traefik entrypoints when raw TCP/UDP ports are needed, and reconciles Terrarium-managed UFW rules for those dynamic ports.
- For auth-protected published routes, the sync job also reconciles a host-side oauth2-proxy route-auth stack and publishes a shared callback under `https://manage.<domain>/oauth2/app/callback`.
- `@auth` means “any authenticated user”.
- `@auth:group1,group2` means “any authenticated user in at least one listed group”.
- Route-level auth is currently limited to HTTP(S) hosts on the Terrarium root domain or its subdomains so that the shared callback and cookie domain remain valid.

## Storage

Terrarium creates a dedicated ZFS pool for LXD using one of three modes:

- `disk`
  Dedicated non-root block device. Terrarium wipes it and creates the pool directly on that device.
- `partition`
  Existing unused partition or allocatable free space on a non-root disk. Interactive mode discovers allocatable targets and suggests the largest one. Non-interactive mode requires `--storage-source`, and `--storage-source auto` resolves to the largest valid target.
- `file`
  File-backed ZFS pool on the root filesystem. This is the fallback when the VPS has only the root disk or when the provider does not support attachable block storage.

Pool behavior:

- Terrarium creates the pool with `compression=zstd`, `atime=off`, `xattr=sa`, and `normalization=formD`.
- Dedup is not enabled.
- Terrarium does not attempt to shrink the mounted root filesystem.

## Backup Model

Terrarium has three backup paths:

1. Local rewind
   Managed by `sanoid` on the ZFS pool that backs LXD containers.
2. Optional off-host ZFS replication
   Managed by `syncoid`, recursively replicating `pool/containers` to another ZFS host.
3. Optional S3-style archive export
   Managed by `terrariumctl backup export`, which writes manifests locally and uploads compressed ZFS streams plus JSON manifests to S3-compatible object storage.

Current local snapshot retention:

- `hourly = 24`
- `daily = 14`
- `monthly = 3`

S3 export behavior:

- Terrarium records the last exported snapshot per instance under `/var/lib/terrarium/lastsnapshots`.
- It uploads either a full `zfs send` or an incremental `zfs send -I` stream.
- Streams are compressed with `zstd` before upload.
- JSON manifests are stored locally under `/var/lib/terrarium/catalog` and remotely alongside the streams.

## Restore Model

Local in-place restore:

- Implemented as `zfs rollback -r`.
- Non-interactive apart from the safety confirmation.

Local as-new restore:

- Implemented as a `zfs clone`.
- Terrarium explains what is about to happen and then launches interactive `lxd recover`, because the final import step is still interactive upstream.

S3 in-place restore:

- Terrarium downloads the manifest chain for the selected restore point.
- It replays the compressed ZFS send chain into the target dataset with `zfs receive -F`.

S3 as-new restore:

- Terrarium reconstructs the dataset for the chosen restore point.
- It then explains the next steps and hands off into interactive `lxd recover`, just like local `--as-new`.

## Runtime Paths

Important runtime paths in the current implementation:

- Repo checkout: `/opt/terrarium`
- Persisted config: `/etc/terrarium/config.yaml`
- Secrets directory: `/etc/terrarium/secrets`
- General state: `/var/lib/terrarium`
- oauth2-proxy runtime: `/var/lib/terrarium/oauth2-proxy`
- oauth2-proxy published-route runtime: `/var/lib/terrarium/oauth2-proxy-routes`
- S3 catalog: `/var/lib/terrarium/catalog`
- Last exported snapshots: `/var/lib/terrarium/lastsnapshots`
- Restore workspace: `/var/lib/terrarium/restore`

## Scope

- Supported host OS: Ubuntu Server 24.04
- Deployment model: single host only
- Workload model: LXC containers only
- Terrarium is built around isolated, rewritable container environments for agents, development sandboxes, and exposed internal web apps
