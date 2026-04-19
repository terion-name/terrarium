# Management GUIs

Terrarium is not only for terminal-heavy users.

One of its practical advantages is that it gives you several browser-based admin interfaces out of the box, so you can create containers, inspect storage, manage routes, and understand what the host is doing without memorizing every command first.

By default, the management UIs are:

- `manage.<domain>` for Cockpit
- `proxy.<domain>` for the Traefik dashboard
- `lxd.<domain>` for the LXD UI

All three are management surfaces. They are separate from the apps you publish from inside containers.

## Cockpit

Cockpit is the main host management UI.

It is the best place to start if you want a graphical way to:

- inspect the server
- watch services and logs
- use the built-in terminal
- manage the firewall and networking
- browse ZFS through the installed Cockpit extensions

Terrarium ships Cockpit together with cockpit-zfs and cockpit-S3ObjectBroswer, which makes the storage side much more approachable for non-experts.

Authentication model:

- first, you pass Terrarium's OIDC gate
- then you log into Cockpit with a local host account

Official screenshot:

![Cockpit overview](/screenshots/cockpit-overview.webp)

Source: [Cockpit project homepage](https://cockpit-project.org/)

## LXD UI

The LXD UI is where you manage containers directly.

It is useful for:

- creating and deleting instances
- inspecting instance state
- working with profiles, networks, and storage pools
- managing snapshots and projects

This is the UI Terrarium users will often spend the most time in once the host is up.

Authentication model:

- native LXD OIDC
- access limited to the Terrarium admin group

Official screenshot:

![LXD UI instances view](/screenshots/lxd-ui-instances.png)

Source: [Canonical MicroCloud tutorial](https://documentation.ubuntu.com/microcloud/latest/tutorial/multi-member/)

## Traefik Dashboard

Terrarium also exposes the Traefik dashboard at:

- `proxy.<domain>`

This is useful when you want to see what the host proxy is doing:

- which routers exist
- which services and middlewares are active
- whether published routes are wired the way you expect

That matters a lot once you start publishing apps from inside containers.

Authentication model:

- same Terrarium OIDC gate as the rest of the management surface
- restricted to the Terrarium admin group

Official screenshot:

![Traefik dashboard](/screenshots/traefik-dashboard.png)

Source: [Traefik getting started guide](https://doc.traefik.io/traefik/getting-started/docker/)

## Which UI To Use For What

- use Cockpit for host-level administration
- use LXD UI for container lifecycle and LXD resources
- use the Traefik dashboard when you are debugging or understanding published routes

If you prefer the terminal, all of this is still available through `terrariumctl`, `lxc`, and normal Linux tools. The point of these UIs is that you do not have to start there.
