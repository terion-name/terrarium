# Provider Guides

These guides focus on one Terrarium-friendly pattern:

1. Create an Ubuntu 24.04 VPS
2. Add your SSH key during provisioning
3. Attach separate block storage when the provider supports it
4. Install Terrarium in `disk` mode

Recommended providers for the cleanest Terrarium setup:

| Provider | Separate block storage | CLI creation docs | Best Terrarium mode |
| --- | --- | --- | --- |
| [DigitalOcean](digitalocean.md) | Yes | Yes (`doctl`) | `disk` |
| [Vultr](vultr.md) | Yes | Yes (`vultr-cli`) | `disk` |
| [Hetzner Cloud](hetzner.md) | Yes | Yes (`hcloud`) | `disk` |
| [Hostinger](hostinger.md) | No documented attachable block volume | Limited CLI docs; use hPanel for creation | `file` |

General recommendation:

- Prefer `disk` mode with a separate data volume.
- Keep the boot disk for Ubuntu and host services.
- Reserve the extra volume for LXD and ZFS snapshots.
