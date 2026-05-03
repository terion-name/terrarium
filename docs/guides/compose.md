# Isolated Docker Compose Deployments on Terrarium

Running a Docker Compose stack inside its own LXC container is one of the main Terrarium patterns.

That gives the stack a real Linux environment to live in, while keeping host-level Docker, ports, and runtime state out of the way.

This is especially useful for complex projects that want their own dependencies, databases, helper services, and network assumptions without interfering with other Docker workloads on the same VPS.

Terrarium's LXD `default` profile enables the settings that Docker-in-LXC usually needs:

- `security.idmap.isolated=true`
- `security.nesting=true`
- `security.syscalls.intercept.mknod=true`
- `security.syscalls.intercept.setxattr=true`

That means Compose stacks work with a normal launch and do not need a separate special-case setup:

```bash
lxc launch images:ubuntu/24.04 my-stack
```

## Why this setup works

Running Compose directly on the host is convenient at first, but it becomes messy fast:

- images and volumes from unrelated stacks mix together
- ports become shared host-level decisions
- daemon state becomes one big pile
- one stack’s package or system-level assumptions can leak into another

Terrarium gives each Compose deployment its own boundary:

- the host owns management, ingress, and recovery
- the container owns Docker, Compose, and app runtime state

## Benefits

### Security

The stack lives in an LXC container instead of directly on the host. If the workload is compromised or misconfigured, the host is still a separate layer with a smaller blast radius.

Terrarium's normal workload containers are unprivileged and use isolated ID
maps. That means root inside the LXC, and root inside Docker containers created
by the nested Docker daemon, does not become host root. This is especially
useful for Compose stacks copied from the internet or built by app installers
that assume broad Docker access.

This is still a boundary, not a permission to be careless. Avoid `privileged:
true`, broad host bind mounts, host networking, and public admin panels unless
the app genuinely needs them and you understand the risk.

### Isolation

Each Compose stack gets its own filesystem, packages, images, volumes, and daemon state. That makes it much easier to keep multiple projects on one VPS without constant interference.

### No host Docker conflicts

You do not need to make the whole host a shared Docker machine. One stack can use its own Docker setup inside its own LXC, while the host remains clean and other stacks stay separate.

### Built-in time machine

When a deployment goes sideways, a bad image update lands, or config drift piles up, you can step the container backward instead of rebuilding the entire host.

### Reproducibility

The container becomes the deployment boundary. Combined with Compose files, that gives you a much more repeatable setup than an ad hoc host-level Docker environment.

## Networking pattern

Inside the container, expose the application or gateway service on `0.0.0.0:<port>`. Then publish it through the host with Terrarium’s automated proxy flow.

Example:

```bash
lxc config set my-stack user.proxy "https://app.example.com:3000"
```

That means:

- the service stays inside the LXC
- Traefik on the host handles the public route
- Terrarium keeps the routing configuration in sync automatically

You do not need a separate reverse-proxy stack inside every container unless the application itself requires it for internal reasons.

## Suggested workflow

1. Create a dedicated LXC container for the project with the default Terrarium profile.
2. Install Docker and Compose inside that container.
3. Place the Compose files and environment config inside the container.
4. Start the stack and verify the main service binds to `0.0.0.0:<port>`.
5. Add a `user.proxy` label for the route you want to expose.
6. Snapshot the container once the deployment reaches a stable state.

## When You Outgrow Hand-Managed Compose

The pattern above is intentionally simple: one container, one Docker daemon, one Compose stack or a small group of related services.

If you want to manage many stacks from a browser UI, add remote Docker hosts, trigger deploys from Git, inspect logs, and hand app deployment to a higher-level control plane, use [Dokploy on Terrarium](./dokploy) or [Coolify on Terrarium](./coolify).

The useful mental model is:

- plain Compose guide: each LXC is the app boundary
- Dokploy guide: each LXC can become a Dokploy “server” that runs many Docker deployments
- Coolify guide: each LXC can become a Coolify SSH-managed Docker server, while the Coolify dashboard lives in its own LXC

That lets you keep Terrarium's isolation and time-machine model while using Dokploy or Coolify for day-to-day app deployment.

## If You Want To Disable Docker-Friendly Features

Some people will prefer a stricter baseline for containers that should never run nested container runtimes.

Terrarium pre-creates a `strict` profile for this:

```bash
lxc launch images:ubuntu/24.04 static-site --profile strict
```

Use it for selected containers instead of the Docker-friendly default.

That gives you a practical split:

- `default` for the general Terrarium experience, including Docker/Compose-friendly environments
- `strict` for containers that should never need nested container features

This keeps the project self-contained, safer to operate, and much easier to step backward when changes do not go as planned.
