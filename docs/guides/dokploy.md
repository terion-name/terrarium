# Dokploy on Terrarium

Dokploy is useful when you want a UI-driven deployment control plane for many Docker apps, not just one hand-managed Compose stack.

On Terrarium, the clean model is:

- one LXC container runs the Dokploy UI
- one or more other LXC containers act as Dokploy deployment servers
- each deployment server has its own Docker daemon, volumes, images, and app runtime state
- Terrarium publishes the Dokploy UI and any app domains through the host Traefik

That means Dokploy gets the server model it expects, while Terrarium still gives you LXD isolation and ZFS snapshots around each Docker host.

## When to use this instead of plain Compose

Use [Isolated Docker Compose deployments](./compose) when you want one app stack in one container and you are comfortable managing Compose files yourself.

Use Dokploy when you want:

- a browser UI for many apps and services
- project-level deployment history, logs, environment variables, and redeploy buttons
- remote deployment servers that can be added over SSH
- multiple Docker hosts, where each Terrarium LXC can be treated as a separate Dokploy server

This is a good fit for “many small self-hosted apps” or “several product stacks with different blast radii”.

## Important architecture note

Dokploy normally assumes it owns ports `80`, `443`, and `3000` on the server where it is installed.

Inside Terrarium, that is fine because those ports are inside the `dokploy` LXC, not on the host. The Terrarium host still owns public `80` and `443`.

The practical routing model is:

- Dokploy UI listens on `dokploy:3000`
- Terrarium publishes `https://dokploy.example.com` to `dokploy:3000`
- each Dokploy deployment server LXC runs its own internal Traefik
- Terrarium publishes each app hostname to that deployment-server LXC on port `80`

So you get two proxy layers for app traffic:

```text
internet -> Terrarium Traefik -> app-server LXC Traefik -> app container
```

That sounds like a lot, but it keeps responsibilities clean. Terrarium handles the public edge and host firewall; Dokploy handles per-app routing inside the Docker host it manages.

## Create the Dokploy UI container

You can create the container from the LXD UI or from the host CLI:

```bash
lxc launch images:ubuntu/24.04 dokploy
```

Install Dokploy inside it:

```bash
lxc exec dokploy -- bash
apt-get update
apt-get install -y curl
curl -sSL https://dokploy.com/install.sh | sh
exit
```

Publish the UI through Terrarium:

```bash
lxc config set dokploy user.proxy "https://dokploy.example.com:3000@auth:admins"
terrariumctl proxy sync
```

The `@auth:admins` layer is optional but recommended. Dokploy still has its own login, but this keeps the panel behind Terrarium SSO before the Dokploy login page is even reached.

Open `https://dokploy.example.com` and create the initial Dokploy admin account.

## Create a deployment-server LXC

Each deployment server is where your apps actually run. Start with one:

```bash
lxc launch images:ubuntu/24.04 apps-a
```

Prepare SSH access inside that container. Dokploy’s remote server setup expects SSH and bash.

```bash
lxc exec apps-a -- bash
apt-get update
apt-get install -y bash curl openssh-server
systemctl enable --now ssh
mkdir -p /root/.ssh
chmod 700 /root/.ssh
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart ssh
exit
```

In the Dokploy UI:

1. Open Settings → SSH Keys.
2. Create an SSH key for remote servers.
3. Copy its public key.

Add that public key to the deployment-server container:

```bash
lxc exec apps-a -- bash -lc 'cat >> /root/.ssh/authorized_keys'
```

Paste the public key, press Enter, then press `Ctrl-D`.

Find the private LXD address for the deployment server:

```bash
lxc list apps-a -c n4
```

In Dokploy:

1. Open Remote Servers.
2. Add a Deployment Server.
3. Use the `apps-a` IPv4 address, user `root`, and the SSH key you created.
4. Use Enter Terminal to confirm connectivity.
5. Run Setup Server from the Deployments tab.
6. Wait until Dokploy validates Docker, Swarm, the Dokploy network, and its app directory.

Repeat this pattern for `apps-b`, `apps-c`, or any other deployment boundary you want.

## Deploy an app

In Dokploy, create a Project, then create a Docker Compose service.

For most Compose services:

1. Use Dokploy’s Docker Compose mode, not Stack mode, unless you deliberately want Swarm semantics.
2. Put secrets in Dokploy environment variables.
3. In the Compose file, load them with `env_file: .env` or reference the specific variables with `${VAR}`.
4. Prefer Dokploy’s Domains tab over hand-written Traefik labels.
5. Use `expose`, not public `ports`, for app services that should only be reachable through Dokploy’s Traefik.

For persistent data, Dokploy documents two patterns:

- `../files/...` bind mounts when you want direct file access on the deployment server
- Docker named volumes when you want Dokploy’s volume backup features

For databases and important app state, named volumes are usually the better default.

## Publish app domains through Terrarium

Dokploy can configure the route inside the deployment-server LXC, but the public internet still reaches the Terrarium host first.

If `apps-a` hosts:

- `https://whoami.example.com`
- `https://notes.example.com`

then expose those hostnames from the Terrarium host to the `apps-a` container’s internal Traefik on port `80`:

```bash
lxc config set apps-a user.proxy "https://whoami.example.com:80,https://notes.example.com:80"
terrariumctl proxy sync
```

In Dokploy, configure the same domains on the Compose services using the Domains tab. Dokploy will route by `Host` header inside `apps-a`; Terrarium will terminate public TLS and forward HTTP to `apps-a:80`.

When you add another app domain to that deployment server, append it to the same comma-separated `user.proxy` label and run `terrariumctl proxy sync` again.

## Recommended deployment boundaries

Treat each LXC as a Dokploy server with a clear purpose:

- `apps-public`: low-risk public websites
- `apps-internal`: internal tools, route-protected by Terrarium when possible
- `apps-labs`: experiments and disposable stacks
- `apps-client-a`: one client or project with separate snapshots and rollback

This is the nice Terrarium/Dokploy combination: Dokploy gives you the app deployment UI, and Terrarium gives you server-shaped isolation without buying a separate VPS for each boundary.

## Snapshots and rollback

Before major app migrations or Dokploy server changes, snapshot the deployment-server LXC:

```bash
lxc snapshot apps-a before-big-upgrade
```

If a deploy damages the Docker host badly enough that normal rollback is painful, restore the LXC snapshot instead of rebuilding the whole VPS.

Dokploy’s own volume backups still matter for application-level recovery. Use Terrarium snapshots for infrastructure rollback and Dokploy/S3 backups for app data portability.

## Security notes

- Keep remote server SSH on the private LXD network; do not publish SSH from app-server containers.
- Use key-based SSH only.
- Do not expose Docker ports with public `ports:` unless you intentionally want them reachable through the deployment-server network path.
- Remember that Docker can bypass UFW on a normal host; inside this model, Docker is inside the LXC and Terrarium’s host firewall remains the public edge.
- Use Terrarium route auth for the Dokploy UI, and use Dokploy’s own auth and permissions inside the panel.

## Upstream docs used for this guide

- [Dokploy installation](https://docs.dokploy.com/docs/core/installation)
- [Dokploy remote servers](https://docs.dokploy.com/docs/core/remote-servers)
- [Dokploy deploy server instructions](https://docs.dokploy.com/docs/core/remote-servers/instructions)
- [Dokploy remote server validation](https://docs.dokploy.com/docs/core/remote-servers/validate)
- [Dokploy Docker Compose](https://docs.dokploy.com/docs/core/docker-compose)
- [Dokploy Docker Compose domains](https://docs.dokploy.com/docs/core/docker-compose/domains)
- [Dokploy remote server security](https://docs.dokploy.com/docs/core/remote-servers/security)
