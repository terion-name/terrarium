# Security Model

Terrarium is designed to make the safe path feel natural, especially for people who want powerful environments without becoming full-time infrastructure operators.

The short version:

- containers are private by default
- the host is hardened
- public exposure is explicit
- a built-in time machine is part of the default storage model

## Private By Default Networking

This is one of Terrarium's most important properties.

LXC containers live behind LXD's private bridge and NAT by default. They do not sit on the public internet with every open service directly reachable from the outside.

That means:

- random internet scans do not hit container services directly
- a service listening on `0.0.0.0` inside the container is still not automatically public
- databases, Redis, metrics ports, dev servers, admin panels, and internal APIs can exist inside the container without instantly becoming internet-facing

Something only becomes public when you explicitly expose it through Terrarium.

Usually that means one of these:

- publish an HTTP(S) route with `user.proxy`
- publish a specific raw TCP or UDP port

If you do neither, the workload stays private behind the host.

## Why This Is Useful In Practice

This matters a lot for the kinds of workloads Terrarium is built for.

Examples:

- an agent can install packages, run background services, and open local ports without turning the whole VPS into a public attack surface
- a Docker Compose stack inside an LXC can expose Postgres, Redis, worker dashboards, and internal APIs for local use inside that environment without making them reachable from the internet
- a web IDE can listen on `0.0.0.0:8080` inside the container and still stay private until you deliberately publish it

This does not make bad software safe. It does reduce the blast radius of simple mistakes.

## Explicit Exposure

Terrarium keeps exposure intentional.

- web apps are usually published through Traefik
- TLS is handled on the host
- optional OIDC protection can be added at the host layer
- raw TCP and UDP exposure is also explicit and synced into UFW

So the default mental model is:

1. run whatever you need inside the container
2. test it privately
3. publish only the parts that should be reachable

## Host Hardening

Terrarium also hardens the host itself:

- SSH is key-only
- password SSH is disabled
- UFW defaults to deny incoming
- host management tools are protected separately from workloads
- optional local ZITADEL or external OIDC can gate management access

Cockpit and LXD are not just left open on default ports. They are routed and controlled through the Terrarium management layer.

## Docker In Containers

Terrarium enables a Docker-friendly LXD profile by default.

That means the baseline `terrarium` profile includes:

- `security.nesting=true`
- `security.syscalls.intercept.mknod=true`
- `security.syscalls.intercept.setxattr=true`

Why Terrarium does this:

- running Docker Compose inside its own LXC is a very common Terrarium use case
- it keeps complex app stacks away from the host
- it avoids turning the host into one giant shared Docker machine

Tradeoff:

- this is more permissive than a minimal non-nested container profile
- it is a convenience and compatibility choice, not the narrowest possible baseline

If you do not want Docker-friendly features for a given workload, create a stricter profile and launch that container with it:

```bash
lxc profile copy terrarium terrarium-strict
lxc profile set terrarium-strict security.nesting false
lxc profile unset terrarium-strict security.syscalls.intercept.mknod
lxc profile unset terrarium-strict security.syscalls.intercept.setxattr
```

That way you can keep the general Terrarium experience friendly for common real-world workloads, while still choosing stricter containers when you want them.

## The Time Machine As A Security Feature

Security is not only about blocking attackers. It is also about recovering from mistakes.

Terrarium keeps a local time machine with ZFS snapshots, so if a workload breaks itself, gets misconfigured, or an agent makes a bad change, you can often step the environment backward instead of rebuilding it.

If you enable S3 exports, that story extends beyond the host itself. Local snapshots are for fast recovery on the same VPS; S3 exports are for disaster recovery when the machine or disk is gone.

That is especially useful for:

- agent experiments
- temporary sandboxes
- dependency-heavy development environments
- self-hosted apps with risky upgrade steps

## What Terrarium Does Not Do For You

Terrarium improves the default posture, but it does not replace judgment.

You still need to:

- keep software updated
- decide which apps should be public
- decide which routes need OIDC protection
- avoid exposing raw ports unnecessarily
- use reasonable app-level auth where appropriate

Terrarium gives you safer defaults and better recovery. It does not turn every workload into a secure workload automatically.

## Recommended Habit

Treat containers as private first and public second.

If a service does not need to be reachable from outside, do not publish it. If it does need to be reachable, prefer:

1. HTTP(S) through Traefik
2. OIDC protection when the app does not have strong built-in auth
3. raw TCP/UDP exposure only when you actually need it
