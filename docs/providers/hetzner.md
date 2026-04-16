# Terrarium on Hetzner Cloud

Official references:

- [Hetzner Cloud changelog](https://docs.hetzner.cloud/changelog)
- [hcloud CLI manual](https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud.md)
- [hcloud ssh-key create](https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_ssh-key_create.md)
- [hcloud server create](https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_server_create.md)
- [hcloud volume create](https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_volume_create.md)
- [hcloud volume attach](https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_volume_attach.md)

## Recommended shape

- Ubuntu image: `ubuntu-24.04`
- Boot disk: keep the normal server root disk
- Data disk: add a separate Hetzner Cloud Volume
- Terrarium mode: `--storage-mode disk`

## Console flow

1. Add your SSH key to the Hetzner Cloud project.
2. Create a new Ubuntu 24.04 server and select that SSH key.
3. Create a Volume in the same location as the server.
4. Attach the Volume to the server.
5. SSH into the server and install Terrarium with `disk` mode.

Example install:

```bash
curl -fsSL https://github.com/terion-name/terrarium/releases/download/latest/install.sh | bash -s -- \
  --email admin@your-domain.tld \
  --acme-email certs@your-domain.tld \
  --idp local \
  --storage-mode disk \
  --storage-source auto
```

## hcloud flow

Create the SSH key:

```bash
hcloud ssh-key create --name terrarium --public-key-from-file ~/.ssh/id_ed25519.pub
```

Create the Volume:

```bash
hcloud volume create \
  --name terrarium-data \
  --size 200 \
  --location nbg1
```

Create the server:

```bash
hcloud server create \
  --name terrarium-1 \
  --type cpx31 \
  --image ubuntu-24.04 \
  --location nbg1 \
  --ssh-key terrarium
```

Attach the Volume:

```bash
hcloud volume attach --server terrarium-1 terrarium-data
```

Then SSH in and install Terrarium:

```bash
curl -fsSL https://github.com/terion-name/terrarium/releases/download/latest/install.sh | bash -s -- \
  --email admin@your-domain.tld \
  --acme-email certs@your-domain.tld \
  --idp local \
  --storage-mode disk \
  --storage-source auto
```

## Notes

- Hetzner’s current CLI uses `--location`; `--datacenter` is deprecated in the current `hcloud server create` manual.
- `hcloud server create` can also pre-attach a volume with `--volume`, but keeping the steps separate is easier to reason about when you want Terrarium to claim exactly one dedicated data disk.
