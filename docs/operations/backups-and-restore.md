# Backups and Restore

Terrarium has three backup paths:

1. local time machine with ZFS snapshots
2. optional off-host recursive ZFS replication through syncoid
3. optional S3-style archive export using compressed ZFS streams

The mental model is:

- local snapshots are the fast time machine for day-to-day mistakes
- S3 exports are the disaster-recovery copy for losing the host entirely

## Local Time Machine

Local time-machine history is managed by `sanoid` on the ZFS pool that backs LXD containers.

Current default retention:

- `4` 15-minute snapshots
- `24` hourly snapshots
- `14` daily snapshots
- `3` monthly snapshots

Useful commands:

```bash
terrariumctl backup list
terrariumctl backup restore --instance my-app
terrariumctl backup restore --instance my-app --at autosnap_2026-04-19_10:00:00_hourly
```

By default, restore is:

- source: `local`
- restore point: latest snapshot
- mode: in-place

## In-Place Restore

`terrariumctl backup restore --instance NAME` restores in place by default.

Behavior:

- Terrarium stops the instance if needed
- rolls the dataset back with `zfs rollback -r`
- tells you to start the instance again

This path is non-interactive apart from the safety confirmation.

## Restore As New

If you want to recover an instance as a new LXD instance:

```bash
terrariumctl backup restore --instance my-app --as-new my-app-restored
```

Terrarium will:

1. reconstruct or clone the dataset
2. print a clear notice about what happens next
3. launch interactive `lxd recover`

Why this is interactive:

- the final upstream import step still depends on `lxd recover`

## S3 Exports

When S3 is enabled, Terrarium can export the current ZFS backup chain to S3-compatible object storage.

This is the disaster-recovery layer. It is not just another local snapshot copy on the same disk.

Useful command:

```bash
terrariumctl backup export
```

Terrarium:

- records the last exported snapshot per instance under `/var/lib/terrarium/lastsnapshots`
- uploads either a full `zfs send` or incremental `zfs send -I`
- compresses streams with `zstd`
- stores manifests locally under `/var/lib/terrarium/catalog`

## S3 Restore

You can restore from S3 by switching the source:

```bash
terrariumctl backup restore --source s3 --instance my-app
terrariumctl backup restore --source s3 --instance my-app --as-new my-app-restored
```

Defaults still apply:

- if `--at` is omitted, Terrarium uses the latest manifest chain
- if `--as-new` is omitted, Terrarium restores in place

## Syncoid

Syncoid is the off-host ZFS-to-ZFS replication path.

Use it when you have:

- another ZFS host
- SSH connectivity to that host
- a target dataset prepared for replication

It is configured through:

- install flags
- or `terrariumctl set syncoid`

For full CLI details, see [terrariumctl Reference](../reference/terrariumctl.md).
