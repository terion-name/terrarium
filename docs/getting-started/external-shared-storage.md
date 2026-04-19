# External Shared Storage

Sometimes the right place for shared data is **outside** the LXD containers and outside the VPS itself.

Good examples:

- long-lived agent memories
- knowledge bases and research collections
- shared document sets
- personal files you want to browse or edit from your own computer
- data that should survive replacing the VPS entirely

For this pattern, a practical setup is:

1. store the data on a Hetzner Storage Box
2. mount it on the Terrarium host over SMB/CIFS
3. pass that mounted directory into one or more containers
4. also mount the same Storage Box on your own computer when you want to browse or edit it directly

This gives you one shared data location for:

- Terrarium containers
- your own machine
- backup-friendly off-host storage

Hetzner documents SMB/CIFS access for Storage Box, including Linux mounts and `fstab` examples. Source: [Access with SAMBA/CIFS](https://docs.hetzner.com/storage/storage-box/access/access-samba-cifs/)

## When To Use This Pattern

Use external shared storage when:

- the data should outlive a specific container
- the data should still exist if you replace the VPS
- you want to inspect or edit it from your own computer
- the data is more like a shared library or knowledge base than container-local state

This is a strong fit for things like:

- agent memory archives
- shared prompt libraries
- personal knowledge bases
- corpora and notes inspired by workflows like Karpathy-style memory/idea files

## Important Tradeoff

This data is **outside** the normal container filesystem.

That means:

- it is not part of a container's ordinary root disk
- it should be treated as its own storage layer
- it is great for persistence and cross-device access
- but it is not the same as putting data directly inside a container and relying only on the local Terrarium time machine

That tradeoff is usually what you want here.

## Step 1: Create A Storage Box

Create a Hetzner Storage Box and make sure:

- SMB support is enabled
- you know the username and password
- you know the host name, which is typically shaped like:
  - `u12345.your-storagebox.de`

Hetzner's docs note that for the main user, the SMB share name is `backup`. Source: [Access with SAMBA/CIFS](https://docs.hetzner.com/storage/storage-box/access/access-samba-cifs/)

## Step 2: Mount It On The Terrarium Host

Terrarium installs the required SMB/CIFS client tooling on the host by default, and `terrariumctl` can manage the mount for you.

Recommended flow:

```bash
terrariumctl mount add cifs /srv/shared/storage-box //u12345.your-storagebox.de/backup u12345
```

Terrarium will:

- create the host mount point
- write a root-only credentials file under `/etc/terrarium/mounts/`
- add a managed block to `/etc/fstab`
- mount the share immediately

If you prefer, you can also pass the password as the last positional argument:

```bash
terrariumctl mount add cifs /srv/shared/storage-box //u12345.your-storagebox.de/backup u12345 -p your-password
```

But the prompt-based form is safer because it keeps the password out of shell history.

This follows Hetzner's documented SMB/CIFS pattern:

- `//<username>.your-storagebox.de/backup`
- `seal` for encrypted SMB on supported Linux versions
- a separate credentials file

If your target does not support SMB encryption, pass:

```bash
terrariumctl mount add cifs /srv/shared/storage-box //u12345.your-storagebox.de/backup u12345 --seal=false
```

Verify:

```bash
terrariumctl mount list
ls -la /srv/shared/storage-box
```

## Step 3: Pass It Into Containers

Now that the Storage Box is mounted on the host, expose it inside the containers that should use it.

Example:

```bash
lxc config device add openclaw shared-kb disk source=/srv/shared/storage-box path=/mnt/shared-kb
lxc config device add hermes shared-kb disk source=/srv/shared/storage-box path=/mnt/shared-kb
```

This means:

- the host handles the actual SMB mount
- containers just see a normal directory at `/mnt/shared-kb`

That is simpler and more reliable than trying to mount SMB directly inside each container.

## Example Use Cases

### Shared agent memory

Mount the Storage Box into several agent containers:

```bash
lxc config device add openclaw memories disk source=/srv/shared/storage-box/memories path=/srv/memories
lxc config device add hermes memories disk source=/srv/shared/storage-box/memories path=/srv/memories
```

### Shared knowledge base

Put your notes, documents, or research corpus in:

```text
/srv/shared/storage-box/knowledge-base
```

Then mount that into containers:

```bash
lxc config device add researcher knowledge-base disk source=/srv/shared/storage-box/knowledge-base path=/srv/knowledge-base
lxc config device add openclaw knowledge-base disk source=/srv/shared/storage-box/knowledge-base path=/srv/knowledge-base
```

## Step 4: Mount It On Your Own Computer Too

You can also mount the same Storage Box on your laptop or desktop and browse or edit the files yourself.

Hetzner already documents the OS-specific SMB/CIFS steps for:

- Linux
- Windows

See: [Access with SAMBA/CIFS](https://docs.hetzner.com/storage/storage-box/access/access-samba-cifs/)

That is what makes this pattern useful:

- agents can read and write the same data from inside Terrarium
- you can still inspect and edit that data yourself from outside Terrarium

## What Terrarium Writes Under The Hood

If you are curious what the command actually does, the managed mount lives in three places:

- the mounted path you chose, for example `/srv/shared/storage-box`
- a credentials file in `/etc/terrarium/mounts/`
- a Terrarium-managed block in `/etc/fstab`

That means the mount survives reboots, but you do not have to hand-edit `fstab` or credentials files yourself.

## Recommended Directory Layout

If you use a Storage Box this way, a simple structure helps:

```text
/srv/shared/storage-box/
  memories/
  knowledge-base/
  prompts/
  exports/
```

Then mount only the subdirectory each container actually needs.

That is better than dumping the whole share into every container.

## Security Notes

- Treat the host mount as sensitive, because any container you attach it to can see that data.
- Mount only the subdirectories that a given container really needs.
- Do not hand a whole shared archive to every container by default.
- Keep the credentials file on the host readable only by root.

## When To Prefer Internal Sharing Instead

Use [Shared Data Between Containers](./shared-data-between-containers) instead when:

- the data is small
- the data is mostly container-internal
- you do not need direct access from your own machine
- you want to stay fully inside the LXD storage model
