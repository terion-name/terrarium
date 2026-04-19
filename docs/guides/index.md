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

Start here:

- [OpenClaw](/guides/openclaw)
- [Hermes](/guides/hermes)
- [VSCodium Web IDE](/guides/vscode)
- [Isolated Docker Compose deployments](/guides/compose)
- [Protecting published services with OIDC](/guides/auth-protection)
