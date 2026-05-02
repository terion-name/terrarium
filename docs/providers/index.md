# Provider Guides

These guides focus on one Terrarium-friendly pattern:

1. create an Ubuntu 24.04 VPS
2. add your SSH key during provisioning
3. attach separate block storage when the provider supports it
4. install Terrarium in `disk` mode

Recommended providers for the cleanest Terrarium setup:

| Provider | Separate block storage | Private clustering network | CLI creation docs | Best Terrarium mode |
| --- | --- | --- | --- | --- |
| [DigitalOcean](./digitalocean) | Yes | Yes, VPC | Yes (`doctl`) | `disk` |
| [Vultr](./vultr) | Yes | Yes, VPC 2.0 | Yes (`vultr-cli`) | `disk` |
| [Hetzner Cloud](./hetzner) | Yes | Yes, Networks | Yes (`hcloud`) | `disk` |
| [Hostinger](./hostinger) | No documented attachable block volume | No documented multi-VPS private network | Limited CLI docs; use hPanel for creation | `file` |

General recommendation:

- prefer `disk` mode with a separate data volume
- keep the boot disk for Ubuntu and host services
- reserve the extra volume for LXD and ZFS snapshots

Clustering recommendation:

- put every Terrarium cluster member in the same provider private network, VPC, or VPC 2.0 when the provider supports it
- Terrarium clusters use a WireGuard mesh by default, so private networking is recommended but not mandatory
- keep the cluster members in one provider region unless you know that provider's private network spans the regions you want to use
- let `terrariumctl cluster init` auto-discover the best WireGuard endpoint first
- if auto-discovery picks the wrong endpoint, pass `--wireguard-endpoint <private-or-public-ip>:51820`
- open WireGuard `51820/udp` only between exact cluster member endpoint IPs
- do not expose LXD `8443/tcp`, OVN `6641/tcp`, OVN `6642/tcp`, or Geneve `6081/udp` on provider firewalls; Terrarium carries them inside WireGuard

See [Clustering](../operations/clustering) for the Terrarium-side workflow.
