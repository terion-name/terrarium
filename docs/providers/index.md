# Provider Guides

These guides focus on one Terrarium-friendly pattern:

1. create an Ubuntu 24.04 VPS
2. add your SSH key during provisioning
3. attach separate block storage when the provider supports it
4. install Terrarium in `disk` mode

Recommended providers for the cleanest Terrarium setup:

| Provider | Separate block storage | CLI creation docs | Best Terrarium mode |
| --- | --- | --- | --- |
| [DigitalOcean](/providers/digitalocean) | Yes | Yes (`doctl`) | `disk` |
| [Vultr](/providers/vultr) | Yes | Yes (`vultr-cli`) | `disk` |
| [Hetzner Cloud](/providers/hetzner) | Yes | Yes (`hcloud`) | `disk` |
| [Hostinger](/providers/hostinger) | No documented attachable block volume | Limited CLI docs; use hPanel for creation | `file` |

General recommendation:

- prefer `disk` mode with a separate data volume
- keep the boot disk for Ubuntu and host services
- reserve the extra volume for LXD and ZFS snapshots
