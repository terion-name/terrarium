# Terrarium on DigitalOcean

Official references:

- [How to Add SSH Keys to New or Existing Droplets](https://docs.digitalocean.com/products/droplets/how-to/add-ssh-keys/)
- [Set up a Production-Ready Droplet](https://docs.digitalocean.com/products/droplets/getting-started/recommended-droplet-setup/)
- [Linux Images for Droplets](https://docs.digitalocean.com/products/droplets/details/images/)
- [How to Create and Set Up Volumes for Use with Droplets](https://docs.digitalocean.com/products/volumes/how-to/create/)
- [How to Mount Volumes](https://docs.digitalocean.com/products/volumes/how-to/mount/)
- [doctl compute droplet create](https://docs.digitalocean.com/reference/doctl/reference/compute/droplet/create/)
- [doctl compute volume create](https://docs.digitalocean.com/reference/doctl/reference/compute/volume/create/)
- [doctl compute volume-action attach](https://docs.digitalocean.com/reference/doctl/reference/compute/volume-action/attach/)
- [How to Create a VPC](https://docs.digitalocean.com/products/networking/vpc/how-to/create/)
- [doctl vpcs create](https://docs.digitalocean.com/reference/doctl/reference/vpcs/create/)

## Recommended shape

- Ubuntu image: `ubuntu-24-04-x64`
- Boot disk: keep the normal Droplet root disk
- Data disk: add a separate DigitalOcean Volume for Terrarium ZFS
- Terrarium mode: `--storage-mode disk`

## Console flow

1. Create or upload your SSH key in DigitalOcean.
2. Create a new Droplet with Ubuntu 24.04 and select that SSH key.
3. Create a separate Volume in the same region as the Droplet.
4. Attach the volume to the Droplet.
5. Make sure the volume is not left auto-formatted and auto-mounted for normal filesystem use before handing it to Terrarium.
6. SSH into the Droplet as `root`.
7. Run Terrarium and point it at the attached volume.

Example install:

```bash
curl -fsSL https://github.com/terion-name/terrarium/releases/latest/download/install.sh | bash -s -- \
  --email admin@your-domain.tld \
  --acme-email certs@your-domain.tld \
  --idp local \
  --storage-mode disk \
  --storage-source auto
```

`auto` works well here when the Droplet has exactly one extra attached volume.

## doctl flow

Create or import the SSH key:

```bash
doctl compute ssh-key import terrarium --public-key-file ~/.ssh/id_ed25519.pub
doctl compute ssh-key list
```

Create the Volume:

```bash
doctl compute volume create terrarium-data \
  --region fra1 \
  --size 200
```

Create the Droplet with Ubuntu 24.04:

```bash
doctl compute droplet create terrarium-1 \
  --region fra1 \
  --size s-4vcpu-8gb \
  --image ubuntu-24-04-x64 \
  --ssh-keys <ssh-key-id-or-fingerprint>
```

Attach the Volume:

```bash
doctl compute volume-action attach <volume-id> <droplet-id> --wait
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

For clustered Terrarium, put every Droplet in the same DigitalOcean VPC in the
same region. DigitalOcean VPC networks are private to your account and are not
reachable from the public internet.

Create a VPC:

```bash
doctl vpcs create \
  --name terrarium-cluster \
  --region fra1 \
  --ip-range 10.42.0.0/24
```

Capture the VPC UUID:

```bash
doctl vpcs list
```

Create each Terrarium Droplet in that VPC:

```bash
doctl compute droplet create terrarium-1 \
  --region fra1 \
  --size s-4vcpu-8gb \
  --image ubuntu-24-04-x64 \
  --ssh-keys <ssh-key-id-or-fingerprint> \
  --vpc-uuid <vpc-uuid>
```

After installing Terrarium on each node, run:

```bash
terrariumctl cluster init
terrariumctl cluster invite node2
```

Then run the printed `terrariumctl cluster join --token ... --wireguard ...` command on the new
node. Terrarium should auto-select the VPC address as the WireGuard endpoint.
If it does not, pass the private endpoint explicitly and invite peers by their
private address:

```bash
terrariumctl cluster init --wireguard-endpoint 10.42.0.11:51820
terrariumctl cluster invite node2 10.42.0.12
```

Provider firewalls only need WireGuard `51820/udp` between exact VPC member
addresses. Do not expose LXD `8443/tcp`, OVN `6641/tcp`, OVN `6642/tcp`, or
Geneve `6081/udp`; Terrarium carries those inside WireGuard. Public firewall
rules should only cover the normal Terrarium ingress ports documented in
[Services and Endpoints](../reference/services-and-endpoints.md).

## Notes

- DigitalOcean volumes must live in the same region as the Droplet.
- DigitalOcean documents that control-panel-created volumes can auto-format and auto-mount on newer Ubuntu Droplets. Terrarium will wipe the selected data disk for ZFS anyway, so treat the attached volume as dedicated Terrarium storage and remove any normal filesystem mount config before handing it to Terrarium.
