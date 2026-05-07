# Backups and Restore

Terrarium provides three different layers of protection for your data, giving you the flexibility to easily undo a small mistake or recover your entire server after a catastrophe.

1. **The Local Time Machine (ZFS Snapshots):** Fast, automatic snapshots of your containers every 15 minutes.
2. **Disaster Recovery (S3 Exports):** Encrypted and compressed off-site backups to the cloud.
3. **Off-Host Replication (Syncoid):** Constant ZFS-to-ZFS mirroring to a second server (optional).

## The Local Time Machine

By default, Terrarium takes an incredibly lightweight snapshot of your containers in the background using a tool called `sanoid`. 

Your local history retains:
- **4** 15-minute snapshots
- **24** hourly snapshots
- **14** daily snapshots
- **3** monthly snapshots

*(Because ZFS snapshots only store changed data blocks, keeping all of these snapshots requires very little storage space.)*

### Useful Commands

**See your available snapshots:**
```bash
terrariumctl backup list
```

**Restore a container to its absolute latest state (Undo the last 15 minutes):**
```bash
terrariumctl backup restore --instance my-app
```

**Restore a container to a specific point in time:**
```bash
terrariumctl backup restore --instance my-app --at autosnap_2026-04-19_10:00:00_hourly
```

## Restoring In-Place vs. Restoring As New

When you run a standard `restore` command, Terrarium gracefully stops your container, instantly rewinds its hard drive to the requested snapshot, and tells you to start it back up. **This overwrites the broken container.**

But what if you want to inspect a snapshot *without* destroying the current version of the app? 

You can restore a snapshot as a completely **new, separate container**:
```bash
terrariumctl backup restore --instance my-app --as-new my-app-restored
```
*Note: Terrarium automatically strips the network routing labels off the restored copy. This prevents the clone from accidentally hijacking your live website's traffic.*

## Disaster Recovery: S3 Exports

If your VPS catches on fire or is accidentally deleted, local snapshots won't save you. You need off-site backups.

If you enabled S3 backups during installation (or later via `terrariumctl set s3`), Terrarium will compress your ZFS snapshots and stream them directly to an S3-compatible bucket (like AWS S3, Cloudflare R2, or Backblaze B2).

**Trigger a manual S3 upload:**
```bash
terrariumctl backup export
```

**Restore a completely destroyed container from the cloud:**
```bash
terrariumctl backup restore --source s3 --instance my-app
```
*(This command works exactly the same as a local restore, but it will download and unpack the heavy ZFS data from your S3 bucket first.)*

## Backing Up Your Logins (ZITADEL)

If you are using Terrarium's built-in local login provider (ZITADEL), your entire authentication database is actually running inside a hidden LXD container named `terrarium-idp`. 

This means it is automatically protected by the exact same time machine.

**See the health of your login provider:**
```bash
terrariumctl idp status
```

**Force an immediate backup of your login database:**
```bash
terrariumctl idp backup
```

**Undo a catastrophic change to your users/groups:**
```bash
terrariumctl idp restore
```

*(You can even restore your login database from an S3 backup if your entire server goes down.)*

---

## Advanced: Syncoid Replication

If you own a second server running ZFS, Terrarium can constantly stream block-level changes to it over an encrypted SSH connection. 

This gives you a near real-time, instantly bootable replica of your entire infrastructure.

*(You can set this up during installation, or configure it later using `terrariumctl set syncoid`)*