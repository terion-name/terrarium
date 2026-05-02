# Coolify on Terrarium

Coolify is useful when you want a browser deployment platform for Git apps,
Docker Compose projects, databases, and one-click services, while still keeping
each Docker host inside a Terrarium-managed LXC.

On Terrarium, the clean model is:

- one LXC container runs the Coolify dashboard and control plane
- one or more other LXC containers act as Coolify servers
- each Coolify server LXC has its own Docker daemon, volumes, images, and app state
- Terrarium publishes the Coolify dashboard and app domains through the host Traefik

That gives Coolify the SSH-managed server model it expects, while Terrarium
keeps Docker off the host and gives you LXD isolation, OVN networking, and ZFS
snapshots around each Docker host.

## When to use this instead of plain Compose

Use [Isolated Docker Compose deployments](./compose) when you want one stack in
one container and you are comfortable managing Compose files yourself.

Use Coolify when you want:

- Git-based app deployments with a UI
- Docker Compose deployments with editable domains and environment variables
- one-click service templates
- multiple Docker servers managed over SSH
- a control plane that can stay separate from the servers running app workloads

This overlaps with [Dokploy](./dokploy). The Terrarium architecture is similar
for both: treat each LXC as a small private server, then let the deployment
platform manage Docker inside those LXCs.

## Important architecture note

Coolify expects to manage servers over SSH and Docker. Its docs describe two
server types:

- localhost, where Coolify deploys apps to the same server running the dashboard
- remote servers, where Coolify connects to another Linux server over SSH

Inside Terrarium, prefer the remote-server model for anything non-trivial. Run
Coolify itself in `coolify`, then run app workloads in `apps-a`, `apps-b`, and
similar deployment-server LXCs.

The practical routing model is:

- Coolify dashboard runs inside the `coolify` LXC
- Coolify app servers run inside separate LXCs
- each app-server LXC runs Coolify's Docker proxy, usually Traefik
- Terrarium publishes dashboard and app hostnames from the public host edge

For app traffic that gives you two proxy layers:

```text
internet -> Terrarium Traefik -> app-server LXC Coolify proxy -> app container
```

That is intentional. Terrarium owns the public edge and host firewall; Coolify
owns per-app routing inside the Docker host it manages.

## Create the Coolify control-plane container

Create a Docker-capable LXC with the default Terrarium profile:

```bash
lxc launch images:ubuntu/24.04 coolify
```

Install Coolify inside it:

```bash
lxc exec coolify -- bash
apt-get update
apt-get install -y curl
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
exit
```

Coolify's quick installer supports Ubuntu LTS releases, installs Docker Engine
24+, creates `/data/coolify`, configures SSH keys, and starts Coolify. Do not
install Docker from snap; Coolify explicitly does not support snap-based Docker.

Coolify recommends at least 2 CPU cores, 2 GB RAM, and 30 GB free storage. That
is only the control-plane floor; choose a larger Terrarium host or split app
workloads into separate LXCs if you plan to build and run many apps.

## Bootstrap the dashboard

Coolify's installer exposes the initial dashboard on port `8000` and tells you
to create the first admin account immediately. Do that before handing the URL
to anyone else.

Temporarily publish the dashboard through Terrarium:

```bash
lxc config set coolify user.proxy "https://coolify-bootstrap.example.com:8000@auth:admins"
terrariumctl proxy sync
```

Open `https://coolify-bootstrap.example.com`, pass Terrarium SSO, and create
the initial Coolify admin account.

For steady-state use, prefer Coolify's own integrated proxy inside the LXC:

1. In Coolify, configure the dashboard/instance domain for `coolify.example.com`.
2. Use `http://coolify.example.com` inside Coolify if Terrarium terminates public TLS.
3. Start or restart Coolify's proxy from the Coolify server proxy page.
4. Change the Terrarium route to the Coolify LXC's internal proxy port:

```bash
lxc config set coolify user.proxy "https://coolify.example.com:80@auth:admins"
terrariumctl proxy sync
```

This matches Coolify's firewall guidance: direct dashboard ports `8000`,
`6001`, and `6002` are for direct-IP access. Once the dashboard works through a
custom domain and Coolify's integrated proxy, those direct ports should not be
publicly exposed.

## Create a Coolify deployment-server LXC

Each deployment server is where your apps actually run. Start with one:

```bash
lxc launch images:ubuntu/24.04 apps-a
```

Prepare SSH inside that container. Coolify server management requires SSH key
authentication and root's `authorized_keys`.

```bash
lxc exec apps-a -- bash
apt-get update
apt-get install -y bash curl ca-certificates openssh-server
systemctl enable --now ssh
mkdir -p /root/.ssh
chmod 700 /root/.ssh
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart ssh
exit
```

In Coolify:

1. Create or select a private key for server access.
2. Copy the matching public key.
3. Add a new server.
4. Use the `apps-a` private LXD/OVN address, user `root`, and that private key.

Add the public key to the deployment server:

```bash
lxc exec apps-a -- bash -lc 'cat >> /root/.ssh/authorized_keys'
```

Paste the public key, press Enter, then press `Ctrl-D`.

Find the private LXD address:

```bash
lxc list apps-a -c n4
```

Coolify requires Docker Engine 24+ on servers. If the Coolify UI offers a
server validation/install flow, use it. Otherwise install Docker Engine inside
the deployment-server LXC using Docker's official instructions, then validate
the server in Coolify.

Repeat this pattern for `apps-b`, `apps-c`, or any other deployment boundary.

## Deploy an app

In Coolify, create a Project and add an Application or Docker Compose resource.

For Compose deployments, Coolify treats the Compose file as the source of truth.
That means environment variables, storage, and service definitions should live
in the Compose file or Coolify's resource settings, not in ad hoc host edits.

For most apps:

1. Prefer Coolify domains over direct host port mappings.
2. Use `http://app.example.com` in Coolify when Terrarium terminates public TLS.
3. If the app listens on container port `3000`, enter `http://app.example.com:3000` in Coolify.
4. Avoid Compose `ports:` unless you intentionally want a service exposed directly on the LXC network path.
5. Leave internal services without a domain or port mapping.

Coolify's docs call out the same risk: direct Compose `ports:` mappings expose
the service outside the proxy configuration. In Terrarium, that exposure is
still inside the LXC boundary, but it is usually not what you want.

## Publish app domains through Terrarium

Coolify can configure the route inside the deployment-server LXC, but the public
internet still reaches the Terrarium host first.

If `apps-a` hosts:

- `https://whoami.example.com`
- `https://notes.example.com`

then publish those hostnames from Terrarium to the `apps-a` LXC's internal
Coolify proxy on port `80`:

```bash
lxc config set apps-a user.proxy "https://whoami.example.com:80,https://notes.example.com:80"
terrariumctl proxy sync
```

In Coolify, configure the same domains on the relevant resources. Coolify will
route by `Host` header inside `apps-a`; Terrarium will terminate public TLS and
forward HTTP to `apps-a:80`.

When you add another app domain to that deployment server, append it to the same
comma-separated `user.proxy` label and run `terrariumctl proxy sync` again.

## Persistent data

Coolify supports Docker volumes and bind mounts for persistent storage.

Inside Terrarium:

- Docker named volumes live inside the deployment-server LXC and are captured by Terrarium/LXD snapshots.
- Bind mounts are useful when you deliberately mount an external path into the LXC.
- Do not share the same bind-mounted file or directory between multiple app containers unless the app is designed for shared storage and file locking.

For databases and important app state, Docker named volumes are usually the
safer default. Use external/shared storage only when the app explicitly supports
it or when you are following a product-specific storage guide.

## Clustered Terrarium notes

On a Terrarium cluster, put the Coolify control-plane LXC and deployment-server
LXCs on the shared `terrarium-ovn` network. Coolify should talk to deployment
servers through their private OVN addresses, not public node IPs.

Before adding a deployment-server LXC to Coolify, consider pinning a stable OVN
address:

```bash
lxc config show --expanded apps-a
lxc config device override apps-a eth0 ipv4.address=10.154.0.60
```

If your NIC is not named `eth0`, use the NIC name shown by
`lxc config show --expanded`.

With a stable address, Coolify's server record stays valid when you move the
LXC between cluster members:

```bash
terrariumctl cluster move apps-a node2
lxc list apps-a -c n4L
terrariumctl proxy sync
```

Every healthy Terrarium node can serve the same published routes after local
proxy sync. That gives you Terrarium node redundancy, but not automatic app HA:
a given Docker workload still runs inside one deployment-server LXC unless you
deploy multiple copies and configure application-level load balancing.

Coolify has Traefik load-balancing docs for apps deployed on multiple servers.
Use that only when you intentionally deploy the same app to multiple Coolify
servers and understand which Coolify proxy is receiving the load-balanced
domain.

## Recommended deployment boundaries

Treat each LXC as a Coolify server with a clear purpose:

- `coolify`: dashboard and control plane only
- `apps-public`: public websites and APIs
- `apps-internal`: internal tools, optionally route-protected by Terrarium
- `apps-labs`: experiments and disposable stacks
- `apps-client-a`: one client or project with separate snapshots and rollback

This gives you Coolify's deployment UX without turning the Terrarium host into
one giant Docker machine.

## Snapshots and rollback

Before major app migrations or Coolify server changes, snapshot the relevant
LXC:

```bash
lxc snapshot apps-a before-big-upgrade
```

If a deployment damages the Docker host badly enough that normal Coolify
rollback is painful, restore the LXC snapshot instead of rebuilding the whole
VPS.

Coolify backups still matter for application-level recovery. Use Terrarium
snapshots for infrastructure rollback and Coolify/exported backups for app data
portability.

## Security notes

- Keep Coolify server SSH on the private LXD/OVN network; do not publish SSH from app-server containers.
- Use key-based SSH only.
- Keep the Coolify dashboard behind both Coolify auth and Terrarium route auth when possible.
- Do not expose Docker ports with public `ports:` unless you intentionally want them reachable through the deployment-server network path.
- Remember that Docker can bypass UFW on a normal host; inside this model, Docker is inside the LXC and Terrarium's host firewall remains the public edge.
- Use provider firewalls for public host ports, and keep direct Coolify dashboard ports private after the custom-domain route works.

## Upstream docs used for this guide

- [Coolify installation](https://coolify.io/docs/get-started/installation)
- [Coolify server introduction](https://coolify.io/docs/knowledge-base/server/introduction)
- [Coolify firewall](https://coolify.io/docs/knowledge-base/server/firewall)
- [Coolify Docker Compose](https://coolify.io/docs/knowledge-base/docker/compose)
- [Coolify domains](https://coolify.io/docs/knowledge-base/domains)
- [Coolify persistent storage](https://coolify.io/docs/knowledge-base/persistent-storage)
- [Coolify Traefik overview](https://coolify.io/docs/knowledge-base/proxy/traefik/overview)
- [Coolify Traefik load-balancing](https://coolify.io/docs/knowledge-base/proxy/traefik/load-balancing)
