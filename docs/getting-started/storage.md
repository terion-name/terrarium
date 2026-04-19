# Storage and Sizing

Terrarium works best when the host has a small boot disk and a separate disk for LXD container data plus the local ZFS time machine.

## Recommended Storage Strategy

Best setup:

- boot disk for Ubuntu and Terrarium control-plane services
- separate block volume for the ZFS pool that stores LXD containers and snapshots

Recommended mode for that setup:

- `--storage-mode disk`

Fallback:

- if your provider only gives you one disk, use `--storage-mode file`

`partition` mode exists for cases where you already have an unused partition or safe free space on a non-root disk, but it is not the primary Terrarium path.

## How The Local Time Machine Uses Space

Terrarium keeps its local time-machine history as ZFS snapshots on the same pool as the containers.

That means:

- snapshots are copy-on-write, not full copies
- they keep changed blocks for as long as the snapshots exist
- the more your workloads rewrite large files or churn package trees and caches, the more space snapshots will consume over time

Current default local retention:

- `4` 15-minute snapshots
- `24` hourly snapshots
- `14` daily snapshots
- `3` monthly snapshots

So the smallest automatic local time-machine step is 15 minutes.

Pool defaults:

- `compression=zstd`
- dedup disabled

S3 exports are separate from the local time machine. They are streamed from ZFS and compressed with `zstd` before upload, so they do not need extra permanent local storage beyond Terrarium's working state.

## Hardware Guidance

- Minimum practical host:
  - `2 vCPU`
  - `4 GB RAM`
  - `30-40 GB` boot disk
  - separate `80-120 GB` ZFS disk
- Recommended general-purpose host:
  - `4 vCPU`
  - `8-16 GB RAM`
  - `40-60 GB` boot disk
  - separate `150-300 GB` ZFS disk
- Heavier multi-environment or agent-heavy host:
  - `8 vCPU`
  - `16+ GB RAM`
  - `50-80 GB` boot disk
  - `300+ GB` ZFS disk

## How Much ZFS Space To Plan For

As a starting point:

- for moderate churn, plan `2x-3x` your expected live container data
- for churn-heavy workloads, plan `3x-4x`

Examples:

- if you expect `50 GB` of live container data, a good starting point is:
  - `20-30 GB` boot disk
  - `100-150 GB` ZFS disk
- if that same `50 GB` is churn-heavy, prefer:
  - `150-250 GB` ZFS disk
- if you must use `--storage-mode file`, combine both budgets on the root disk:
  - typically `120-180 GB` total for that same `50 GB` workload

## Mode-Specific Notes

### `disk`

- best fit for most providers that support attached block storage
- Terrarium wipes the selected non-root disk and creates the ZFS pool there

### `partition`

- use only when you already have a safe target on a non-root disk
- Terrarium can discover free extents and unused partitions, but it will not shrink the mounted root filesystem

### `file`

- easiest fallback on single-disk VPSes
- host OS, container data, and snapshots all share the same filesystem
- choose a noticeably larger root disk than you would for a separate-disk setup

For provider-specific examples, see [Provider Guides](../providers/README.md).
