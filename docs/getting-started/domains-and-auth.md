# Domains and Authentication

Terrarium gives the host a few public management endpoints and can either self-host the identity provider or use an external one.

Before thinking about domains, it helps to understand one important Terrarium default: containers are private behind LXD NAT unless you explicitly publish something. A service listening inside a container does not become public on its own.

## Default Public Endpoints

By default, Terrarium exposes:

- `https://manage.<dashed-public-ip>.traefik.me` for Cockpit
- `https://lxd.<dashed-public-ip>.traefik.me` for the LXD API and UI
- `https://auth.<dashed-public-ip>.traefik.me` for self-hosted ZITADEL when `--idp=local`

You can override those with:

- `--domain`
- `--manage-domain`
- `--lxd-domain`
- `--auth-domain`

If you set only `--domain`, Terrarium derives:

- `manage.<domain>`
- `lxd.<domain>`
- `auth.<domain>` when self-hosted ZITADEL is enabled

These domains are for management and explicitly published services. They are not a sign that every service inside every container is reachable from outside.

## Email Settings

- `--email`
  Terrarium contact/admin email and the default ZITADEL bootstrap admin email
- `--acme-email`
  ACME account identity for Traefik and LXD certificate automation

If `--acme-email` is omitted, Terrarium falls back to `--email`.

## Management Authentication

Terrarium separates SSH access from web management access.

### SSH

- SSH is hardened to key-based auth
- password SSH is disabled

### Cockpit

Cockpit is protected in two layers:

1. OIDC gate through Traefik `ForwardAuth` and host-level `oauth2-proxy`
2. normal Cockpit PAM login on the host

That means:

- users must pass the OIDC gate first
- Cockpit still needs a usable local host account to log in
- in practice, `root` needs a local password for Cockpit

If `root` does not already have one:

- interactive install prompts for it
- non-interactive install requires `--root-pwd`

Terrarium uses that password during provisioning and does not store the plaintext in `/etc/terrarium/config.yaml`.

### LXD

LXD keeps native OIDC auth and authorization.

- OIDC issuer/client settings are configured by Terrarium
- access is granted only to members of the configured Terrarium admin group

## IDP Modes

Terrarium supports two identity-provider modes.

### `--idp local`

Terrarium deploys ZITADEL on the host and provisions the clients and claims it needs.

Defaults:

- auth domain: `auth.<domain>` or `auth.<dashed-public-ip>.traefik.me`
- admin group: `terrarium-admins`

Terrarium also:

- provisions the management role
- grants that role to the bootstrap admin
- emits a flat `groups` claim for `oauth2-proxy` and LXD

### `--idp oidc`

Terrarium uses an external OIDC provider.

You must provide:

- `--oidc`
- `--oidc-client`
- `--oidc-secret`
- `--admin-group`

Requirements for the external provider:

- allow `https://<manage-domain>/oauth2/callback`
- allow `https://<lxd-domain>/oidc/callback`
- emit a `groups` claim as a JSON string array containing the configured admin group

## Admin Group

The management admin group controls who gets into:

- Cockpit, through `oauth2-proxy`
- LXD, through native OIDC group mapping

Local mode default:

- `terrarium-admins`

External OIDC mode:

- required explicitly through `--admin-group`

This is intentionally separate from app-level route protection. Management access and published app access do not need to be the same thing.

If you want to protect published app routes, continue to [Protecting Published Services with OIDC](../guides/auth-protection.md).
