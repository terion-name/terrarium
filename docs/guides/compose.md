# Isolated Docker Compose Deployments on Terrarium

One of the cleanest Terrarium patterns is to run a Docker Compose stack inside its own LXC container instead of directly on the host. That gives the stack a real Linux environment to live in, while keeping host-level Docker, ports, and runtime state out of the way.

This is especially useful for complex projects that want their own dependencies, databases, helper services, and network assumptions without interfering with other Docker workloads on the same VPS.

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

1. Create a dedicated LXC container for the project.
2. Install Docker and Compose inside that container.
3. Place the Compose files and environment config inside the container.
4. Start the stack and verify the main service binds to `0.0.0.0:<port>`.
5. Add a `user.proxy` label for the route you want to expose.
6. Snapshot the container once the deployment reaches a stable state.

This keeps the project self-contained, safer to operate, and much easier to step backward when changes do not go as planned.
