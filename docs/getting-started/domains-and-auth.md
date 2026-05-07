# Domains and Authentication

Terrarium sets up a few public management endpoints for the host and lets you choose between a self-hosted identity provider or an external one.

## Default Public Endpoints

By default, Terrarium exposes:

- `https://manage.<dashed-public-ip>.traefik.me` for Cockpit
- `https://proxy.<dashed-public-ip>.traefik.me` for the Traefik dashboard
- `https://lxd.<dashed-public-ip>.traefik.me` for the LXD API and UI
- `https://auth.<dashed-public-ip>.traefik.me` for self-hosted ZITADEL when `--idp=local` is used

You can override those endpoints with:

- `--domain`
- `--manage-domain`
- `--proxy-domain`
- `--lxd-domain`
- `--auth-domain`

If you provide a custom root domain like `--domain example.com`, Terrarium automatically derives the subdomains:

- `manage.<domain>`
- `proxy.<domain>`
- `lxd.<domain>`
- `auth.<domain>` (if self-hosted ZITADEL is enabled)

These domains are strictly for management and explicitly published services. A service running inside a container is not reachable from the outside until you deliberately publish it.

## Email Settings

- `--email`: Sets the primary Terrarium contact/admin email and is used as the default ZITADEL bootstrap admin email.
- `--acme-email`: Used as the ACME account identity so Traefik and LXD can automate your SSL certificates.

If you don't provide an `--acme-email`, Terrarium simply falls back to using the primary `--email`.

## Management Authentication

Terrarium enforces a strict separation between command-line SSH access and web management access.

### SSH
- SSH is hardened to allow key-based authentication only.
- Password-based SSH logins are completely disabled.

### Cockpit
Cockpit access requires passing two layers of authentication:

1. An OIDC gate handled through Traefik `ForwardAuth` and host-level `oauth2-proxy`.
2. A standard Cockpit PAM login on the host machine.

This means users must first pass the OIDC Single Sign-On gate. Once past that, they still need a valid local host account to log into Cockpit (in practice, this means `root` needs a local password).

If `root` does not already have a password:
- The interactive installer will prompt you to create one.
- The non-interactive installer requires either the `--generate-root-pwd` or `--root-pwd-file` flag.

When Terrarium generates the password, it saves it securely to `/etc/terrarium/secrets/cockpit_root_password` with root-only permissions. It does not store the plaintext password in your `/etc/terrarium/config.yaml` file.

### LXD
LXD handles its own native OIDC authentication and authorization.
- Terrarium automatically configures the necessary OIDC issuer and client settings.
- Access is strictly granted only to members of your configured Terrarium admin group.

## Identity Provider (IDP) Modes

Terrarium supports two different ways to handle user logins.

### Mode 1: Local (`--idp local`)

Terrarium deploys ZITADEL directly on the host and automatically provisions the clients and claims it needs.

Defaults:
- Auth domain: `auth.<domain>` or `auth.<dashed-public-ip>.traefik.me`
- Admin group: `terrarium-admins`

Terrarium will automatically:
- Provision the necessary management role.
- Grant that role to the bootstrap admin user.
- Emit a flat `groups` claim for `oauth2-proxy` and LXD to read.

### Mode 2: External OIDC (`--idp oidc`)

If you prefer to use an external provider (like Google Workspace, GitHub, or Auth0), Terrarium can connect to it.

You must provide the following:
- `--oidc`
- `--oidc-client`
- `--oidc-secret-file` or `--oidc-secret`
- `--admin-group`

**Requirements for your external provider:**
You must configure your provider to allow the following callback URLs:
- `https://<manage-domain>/oauth2/callback`
- `https://<proxy-domain>/oauth2/callback`
- `https://<lxd-domain>/oidc/callback`
- If you plan to protect published app routes with `@auth`, you must also allow each generated app callback: `https://<route-host>/oauth2/route/<generated-route-id>/callback`

Additionally, the external provider must emit a `groups` claim as a JSON string array containing the configured admin group.

Terrarium reuses the exact same external OIDC client for:
- Cockpit's oauth2-proxy
- LXD
- Published HTTP(S) routes protected with the `@auth` label

If your identity provider requires you to use a separate client specifically for LXD, you can pass `--lxd-oidc-client` and `--lxd-oidc-secret-file`. For automated setups, always prefer using the secret-file flags over passing secrets directly as arguments.

## The Admin Group

The management admin group controls who is allowed to access:
- Cockpit (through `oauth2-proxy`)
- LXD (through native OIDC group mapping)

- **Local mode default:** `terrarium-admins`
- **External OIDC mode:** You must explicitly define this using `--admin-group`

This group is intentionally kept separate from app-level route protection. You can grant a user access to a published app without giving them management access to the Terrarium host.

If you want to learn how to lock your published apps behind this same authentication system, continue to the [Protecting Published Services with OIDC](../guides/auth-protection.md) guide.
