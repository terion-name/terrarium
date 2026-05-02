# Provider Guides

These guides focus on one Terrarium-friendly pattern:

1. Create an Ubuntu 24.04 VPS
2. Add your SSH key during provisioning
3. Attach separate block storage when the provider supports it
4. Install Terrarium in `disk` mode

Recommended providers for the cleanest Terrarium setup:

| Provider | Separate block storage | Private clustering network | CLI creation docs | Best Terrarium mode |
| --- | --- | --- | --- | --- |
| [DigitalOcean](digitalocean.md) | Yes | Yes, VPC | Yes (`doctl`) | `disk` |
| [Vultr](vultr.md) | Yes | Yes, VPC 2.0 | Yes (`vultr-cli`) | `disk` |
| [Hetzner Cloud](hetzner.md) | Yes | Yes, Networks | Yes (`hcloud`) | `disk` |
| [Hostinger](hostinger.md) | No documented attachable block volume | No documented multi-VPS private network | Limited CLI docs; use hPanel for creation | `file` |

> [!WARNING]
> Hostinger is included because it is popular with agent users and often comes up when people are experimenting with low-cost VPS hosts. But we do not recommend it for Terrarium because it lacks independently attachable block storage and a private multi-node network for clustering.

General recommendation:

- Prefer `disk` mode with a separate data volume.
- Keep the boot disk for Ubuntu and host services.
- Reserve the extra volume for LXD and ZFS snapshots.

Clustering recommendation:

- Put every Terrarium cluster member in the same provider private network, VPC, or VPC 2.0 when the provider supports it.
- Terrarium clusters use a WireGuard mesh by default, so private networking is recommended but not mandatory.
- Keep the cluster members in one provider region unless you know that provider's private network spans the regions you want to use.
- Let `terrariumctl cluster init` auto-discover the best WireGuard endpoint first.
- If auto-discovery picks the wrong endpoint, pass `--wireguard-endpoint <private-or-public-ip>:51820`.
- Open WireGuard `51820/udp` only between exact cluster member endpoint IPs.
- Do not expose LXD `8443/tcp`, OVN `6641/tcp`, OVN `6642/tcp`, or Geneve `6081/udp` on provider firewalls; Terrarium carries them inside WireGuard.

See [Clustering](../operations/clustering.md) for the Terrarium-side workflow.
