# Services and Endpoints

When you install Terrarium, it sets up a powerful, hardened environment using several industry-standard tools. Here is a breakdown of what runs where, how it's secured, and where you can find its configuration.

---

## 🛠️ The Core Stack

Terrarium automatically installs and configures the following tools on your host machine:

- **[LXD](https://github.com/canonical/lxd):** The hypervisor that runs your isolated Linux containers.
- **[OpenZFS](https://github.com/openzfs/zfs):** The advanced file system providing instant snapshots and data integrity.
- **[Cockpit](https://github.com/cockpit-project/cockpit):** A visual web dashboard for managing the host server.
- **[Traefik](https://github.com/traefik/traefik):** The dynamic proxy that handles routing and Let's Encrypt SSL certificates.
- **[ZITADEL](https://github.com/zitadel/zitadel) (Optional):** Your built-in Single Sign-On (SSO) provider.
- **[OAuth2-Proxy](https://github.com/oauth2-proxy/oauth2-proxy):** The gatekeeper that forces users to authenticate before accessing protected routes.
- **[Sanoid / Syncoid](https://github.com/jimsalterjrs/sanoid):** Automated ZFS snapshot retention and replication.
- **[devsec.hardening](https://github.com/dev-sec/ansible-collection-hardening):** An Ansible collection that automatically secures the host OS and SSH settings.

---

## 🌐 Public Endpoints

By default, Terrarium publishes the following URLs (which automatically resolve to your server's IP via `traefik.me`):

| Service | Default URL | Purpose |
| --- | --- | --- |
| **Cockpit** | `manage.<your-ip>.traefik.me` | Manage the host server, read logs, check ZFS. |
| **Traefik** | `proxy.<your-ip>.traefik.me` | View live network routing rules. |
| **LXD UI** | `lxd.<your-ip>.traefik.me` | Create and manage containers. |
| **ZITADEL** | `auth.<your-ip>.traefik.me` | Manage users and SSO (if using `--idp local`). |

*(You can override these to use your own custom domain using the `terrariumctl set domains` command).*

---

## 🔒 Security Posture

- **SSH:** Restricted to Key-Based authentication only. Password logins are disabled.
- **Cockpit & Traefik Dashboards:** Protected by the Terrarium SSO gate (`oauth2-proxy`). You must log in via your identity provider first. Cockpit requires a secondary login using the host's `root` password.
- **LXD Dashboard:** Uses native OIDC. You must belong to the Terrarium "Admin Group" to gain access.
- **Your Apps:** Completely private by default. If you publish an app using the `user.proxy="...@auth"` tag, it is automatically protected by the same SSO gate.

---

## 📁 Important File Paths

If you ever need to dig into the server's internals, here is where everything lives:

| Path | What's Inside? |
| --- | --- |
| `/etc/terrarium/config.yaml` | Optional root-only human-readable export, created by `terrariumctl config export` or transiently during reconciliation. |
| `/etc/terrarium/secrets/` | Generated passwords (like your Cockpit root login). |
| `/var/lib/terrarium/` | General state files, S3 backup manifests, and OAuth proxy configs. |
| `/opt/terrarium/` | The installed Terrarium bundle: compiled `terrariumctl` and Ansible provisioning assets. |

*Note: The **canonical** configuration is stored inside LXD's `dqlite` database. Do not edit `/etc/terrarium/config.yaml` by hand; always use `terrariumctl set` commands.*

---

## 🔗 Internal Cluster Ports (Advanced)

If you link multiple Terrarium servers into a cluster, they communicate over a highly secure WireGuard mesh. 

**Publicly Exposed Ports:**
- **`51820/udp`**: The *only* port opened between cluster members. This handles the encrypted WireGuard tunnel.

**Internal Ports (Carried safely *inside* the WireGuard tunnel):**
- **`8443/tcp`**: LXD cluster communication.
- **`6641/tcp` & `6642/tcp`**: OVN database traffic (which Terrarium secures with mutual TLS certificates).
- **`6081/udp`**: OVN overlay traffic (container-to-container communication).

You never need to open these internal ports on your hosting provider's firewall. Terrarium handles all the complex routing securely through the single WireGuard connection.
