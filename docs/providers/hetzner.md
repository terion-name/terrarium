# Terrarium on Hetzner Cloud

Official references:

- [Hetzner Cloud changelog](https://docs.hetzner.cloud/changelog)
- [hcloud CLI manual](https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud.md)
- [hcloud ssh-key create](https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_ssh-key_create.md)
- [hcloud server create](https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_server_create.md)
- [hcloud volume create](https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_volume_create.md)
- [hcloud volume attach](https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_volume_attach.md)
- [Hetzner Networks overview](https://docs.hetzner.com/networking/networks/overview/)
- [hcloud network create](https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_network_create.md)
- [hcloud network add-subnet](https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_network_add-subnet.md)
- [hcloud server attach-to-network](https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_server_attach-to-network.md)

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
curl -fsSL https://github.com/terion-name/terrarium/releases/latest/download/install.sh | bash -s -- \
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
curl -fsSL https://github.com/terion-name/terrarium/releases/latest/download/install.sh | bash -s -- \
  --email admin@your-domain.tld \
  --acme-email certs@your-domain.tld \
  --idp local \
  --storage-mode disk \
  --storage-source auto
```

## Private network for clustering

For clustered Terrarium, create a Hetzner Cloud Network first and attach every
Terrarium node to it. Hetzner Networks give servers private IP addresses that
are not on the public internet, which is the right place for LXD cluster and
OVN traffic.

Example private network:

```bash
hcloud network create \
  --name terrarium-cluster \
  --ip-range 10.42.0.0/16

hcloud network add-subnet terrarium-cluster \
  --type server \
  --network-zone eu-central \
  --ip-range 10.42.0.0/24
```

Create each node in the same location and attach it to the network:

```bash
hcloud server create \
  --name terrarium-1 \
  --type cpx31 \
  --image ubuntu-24.04 \
  --location nbg1 \
  --ssh-key terrarium \
  --network terrarium-cluster
```

If you already created the server, attach it afterward:

```bash
hcloud server attach-to-network terrarium-1 --network terrarium-cluster
```

After installing Terrarium on each node, run the normal cluster flow:

```bash
terrariumctl cluster init
terrariumctl cluster invite node2
```

Then run the printed `terrariumctl cluster join --token ...` command on the new
node. Terrarium should auto-select the Hetzner private address. If it does not,
pass the private address and exact peer addresses explicitly:

```bash
terrariumctl cluster init \
  --address 10.42.0.11:8443 \
  --peer-cidr 10.42.0.12/32
```

Keep LXD `8443/tcp`, OVN `6641/tcp`, OVN `6642/tcp`, and Geneve `6081/udp`
restricted to the exact Hetzner Network member addresses. Only use a broader
Hetzner Network subnet if every host attached to that network is trusted to
reach the cluster control plane.

## Notes

- Hetzner’s current CLI uses `--location`; `--datacenter` is deprecated in the current `hcloud server create` manual.
- `hcloud server create` can also pre-attach a volume with `--volume`, but keeping the steps separate is easier to reason about when you want Terrarium to claim exactly one dedicated data disk.
