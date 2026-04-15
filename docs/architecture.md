# Terrarium Architecture

Terrarium is intentionally split into three layers:

1. `install.sh`
   Thin bootstrap only. The release-published installer is pinned to its own release, downloads the matching compiled `terrariumctl` bundle from Releases, and falls back to a source build only for branch-like refs.
2. `terrariumctl`
   Single Terrarium binary. It provides `install`, `backup`, `proxy`, `idp`, and maintenance subcommands, clones or updates the Terrarium repository into `/opt/terrarium`, stages the compiled binary into that checkout, and invokes Ansible locally when needed.
3. Ansible
   Owns host provisioning and idempotent configuration.
4. Host helpers
   Systemd timers and services invoke `terrariumctl` subcommands for post-install operations that are easier to run from the server than to model purely as Ansible tasks.

## Control Plane

- Traefik is the only public web entrypoint.
- Cockpit listens on loopback and is reverse proxied through Traefik.
- LXD listens on loopback and is TCP-passthrough proxied through Traefik.
- A host-side sync job reads container `user.proxy` labels and generates Traefik config every minute.

## Storage

- `disk`: dedicated block device, wiped and turned into a ZFS pool.
- `partition`: prepared partition target or a whole non-root disk that Terrarium can partition.
- `loop`: a file-backed ZFS pool on the root filesystem.

## Backups

- `sanoid` manages local snapshots.
- `syncoid` optionally pushes recursive incremental replication to another ZFS host.
- Terrarium can additionally upload compressed ZFS streams and JSON manifests to S3-compatible object storage.

## Restore Model

- Local in-place restore is a `zfs rollback`.
- Local as-new restore is a `zfs clone`; Terrarium then explains the next steps and hands off into interactive `lxd recover` because the final LXD import step is still interactive upstream.
- S3 restore reconstructs a chosen chain into a target dataset and then either:
  - reuses the existing LXD instance path for in-place restore, or
  - explains the next steps and hands off into interactive `lxd recover` for as-new restore.
