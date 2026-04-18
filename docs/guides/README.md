# Guides

These guides are meant to be concrete runbooks, not just ideas.

Each page below explains:

- what to install inside the LXC
- how to create the container in the shipped LXD UI or from the CLI
- the humane interactive path for configuring the workload from inside the container
- a separate host-side automation version for people who want a condensed script
- how authentication works
- whether the service should stay private, use Terrarium's `user.proxy`, or follow a different access pattern
- why Terrarium is a good fit for that workload in the first place

Important: not every workload should be exposed the same way.

- [Hermes](hermes.md) maps cleanly to Terrarium's normal reverse-proxy pattern.
- [VSCodium Web IDE](vscode.md) is the recommended browser-editor path for Terrarium: open marketplace by default, normal web serving, and clean `user.proxy` exposure.
- [OpenClaw](openclaw.md) is different. Upstream recommends keeping the gateway on loopback and accessing it through SSH or Tailscale unless you are intentionally configuring a secured non-loopback deployment.
- [Isolated Docker Compose deployments](compose.md) are a good fit when you want a whole app stack inside one rewindable container.
- [Protecting published services with OIDC](auth-protection.md) explains the recommended SSO pattern for routes that should not rely on weak or missing built-in auth.
