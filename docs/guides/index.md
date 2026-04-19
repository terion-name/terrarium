# Guides

These guides are meant to be concrete runbooks, not just ideas.

Each page explains:

- what to install inside the LXC
- how to create the container in the shipped LXD UI or from the CLI
- the humane interactive path for configuring the workload from inside the container
- a separate host-side automation version for people who want a condensed script
- how authentication works
- whether the service should stay private, use Terrarium's `user.proxy`, or follow a different access pattern
- why Terrarium is a good fit for that workload in the first place

One important default behind all of these guides: workloads inside LXC containers are private until you publish them. That is why Terrarium is comfortable for things like agent runtimes, dev servers, browser IDEs, and full Compose stacks. You can run a lot inside the container without making all of it internet-facing by accident.

Start here:

- [OpenClaw](./openclaw)
- [Hermes](./hermes)
- [VSCodium Web IDE](./vscode)
- [Isolated Docker Compose deployments](./compose)
- [Protecting published services with OIDC](./auth-protection)
