# Terrarium on Vultr

Official references:

- [How to Add Vultr SSH Keys](https://docs.vultr.com/platform/other/ssh-keys/add-ssh-keys)
- [SSH Keys reference](https://docs.vultr.com/reference/vultr-cli/ssh-keys)
- [Create SSH key](https://docs.vultr.com/reference/vultr-cli/ssh-keys/create)
- [How to Provision Vultr Cloud Compute Instances](https://docs.vultr.com/products/compute/cloud-compute/provisioning)
- [Instance create](https://docs.vultr.com/reference/vultr-cli/instance/create)
- [Block Storage provisioning](https://docs.vultr.com/products/cloud-storage/block-storage/provisioning)
- [Block Storage create](https://docs.vultr.com/reference/vultr-cli/block-storage/create)
- [Block Storage attach](https://docs.vultr.com/reference/vultr-cli/block-storage/attach)
- [How to Mount Vultr Block Storage Volume on Linux](https://docs.vultr.com/products/cloud-storage/block-storage/mount/linux)

## Recommended shape

- Ubuntu image: Ubuntu 24.04 LTS x64
- Boot disk: keep the normal instance root disk
- Data disk: add separate Block Storage in the same region
- Terrarium mode: `--storage-mode disk`

## Console flow

1. Add your SSH key to Vultr.
2. Create a new Cloud Compute instance with Ubuntu 24.04 and that SSH key.
3. Create a Block Storage volume in the same region.
4. Attach the Block Storage volume to the instance.
5. SSH into the server and install Terrarium with `disk` mode.

Example install:

```bash
curl -fsSL https://github.com/terion-name/terrarium/releases/latest/download/install.sh | bash -s -- \
  --email admin@your-domain.tld \
  --acme-email certs@your-domain.tld \
  --idp local \
  --storage-mode disk \
  --storage-source auto
```

## vultr-cli flow

Create the SSH key:

```bash
vultr-cli ssh-key create --name terrarium --key "$(cat ~/.ssh/id_ed25519.pub)"
```

Create the instance:

```bash
vultr-cli instance create \
  --region=fra \
  --plan=vc2-4c-8gb \
  --os=2284 \
  --label=terrarium-1 \
  --host=terrarium-1 \
  --ssh-keys="<ssh-key-id>"
```

Create the Block Storage volume:

```bash
vultr-cli block-storage create \
  --region=fra \
  --size=200 \
  --label=terrarium-data
```

Attach the Block Storage volume:

```bash
vultr-cli block-storage attach <block-storage-id> --instance=<instance-id>
```

Then SSH in and install Terrarium:

```bash
curl -fsSL https://github.com/terion-name/terrarium/releases/latest/download/install.sh | bash -s -- \
  --email admin@your-domain.tld \
  --acme-email certs@your-domain.tld \
  --idp local \
  --storage-mode disk \
  --storage-source auto
```

## Notes

- Vultr documents that Block Storage and the instance must be in the same region.
- Vultr’s Linux mount guide is useful if you want to inspect the device before handing it to Terrarium, but Terrarium will wipe the selected data disk for ZFS.
