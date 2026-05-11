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

## Published App Route Labels

Container apps become public only when you add a `user.proxy` label to the LXD instance. The label tells Terrarium which public domain to serve and which private port inside the container to forward to.

For normal web apps, use this format:

```text
https://<public-host>[:container-port][/path][@auth[:group[,group...]]]
```

Examples:

```bash
lxc config set my-app user.proxy "https://app.example.com:8080"
lxc config set admin-ui user.proxy "https://admin.example.com:3000@auth"
lxc config set dev-tool user.proxy "https://dev.example.com:8080@auth:admins,devops"
terrariumctl proxy sync
```

In the LXD UI, open the instance, go to **Configuration**, choose **Edit YAML**, and add the label under `config:`:

```yaml
config:
  user.proxy: https://app.example.com:8080
```

Save the YAML, then wait for a minute or run `terrariumctl proxy sync` from the host shell if you want the route applied immediately.

What each part means:

- `https://app.example.com` is the public domain Traefik will serve.
- `:8080` is the port inside the container. If omitted, Terrarium uses container port `80`.
- `/path` is optional and is matched as a path prefix.
- `@auth` requires a successful OIDC login before traffic reaches the app.
- `@auth:admins,devops` also requires membership in one of those groups.

Use `https://` for normal public routes. Terrarium will request a Let's Encrypt certificate and redirect plain HTTP to HTTPS. Query strings and URL fragments are not part of route labels. Wildcard route hosts such as `*.example.com` are not supported; each published hostname needs its own explicit label.

You can publish more than one route from the same container by separating routes with commas or newlines:

```bash
lxc config set my-app user.proxy "https://app.example.com:8080,https://api.example.com:3000/api"
terrariumctl proxy sync
```

Raw TCP and UDP routes are also supported:

```text
tcp://<public-port>:<container-port>
udp://<public-port>:<container-port>
```

Examples:

```bash
lxc config set postgres user.proxy "tcp://15432:5432"
lxc config set game user.proxy "udp://25565:25565"
terrariumctl proxy sync
```

TCP and UDP routes do not support domains, paths, TLS termination, or `@auth`. Terrarium creates a dedicated Traefik entrypoint and opens the matching managed firewall port.

For every label format, the service inside the container must listen on `0.0.0.0`, not only `127.0.0.1`. Terrarium syncs labels automatically every minute, but `terrariumctl proxy sync` applies changes immediately.

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

Additionally, the external provider must emit a `groups` claim as a JSON string array containing the configured admin group. A provider-side role assignment is not enough unless the issued ID token or userinfo response actually contains that value in `groups`. Check your IDP documentation to set this up properly.

---

> [!WARNING]
> ZITADEL Cloud is probably most unintuitive and weird in this regard, and as we use it as default idp provider, here are the quirks

For ZITADEL Cloud there is no direct concept of groups, they operate with project roles. And project roles are not emitted as a flat `groups` claim by default, they are emited in their own claims. So do the following:

1. In Project the app is added in, in settings (first screen at project) enable "Return user roles during authentication"
2. In the app go to "Token settings" and enable "User roles inside ID Token" and "Include user's profile info in the ID Token"
3. Go to "Actions" (in top menu), add new script named "groupsClaim", place there:
```js
function groupsClaim(ctx, api) {
  var groups = [];
  if (!ctx || !ctx.v1 || !ctx.v1.user || !ctx.v1.user.grants || !ctx.v1.user.grants.grants) {
    api.v1.claims.setClaim("groups", groups);
    return;
  }
  for (var i = 0; i < ctx.v1.user.grants.grants.length; i++) {
    var grant = ctx.v1.user.grants.grants[i];
    if (!grant || !grant.roles) continue;
    for (var j = 0; j < grant.roles.length; j++) {
      var role = grant.roles[j];
      if (groups.indexOf(role) === -1) groups.push(role);
    }
  }
  api.v1.claims.setClaim("groups", groups);
}
```
4. In "Flows" below select "Complement Token" flow type, add trigger "Pre access token creation" and set action "groupsClaim". Then the same for trigger "Pre Userinfo creation"

This will add required claim to token. We hope that Zitadel team will make it easier in future, but for now it is how it is.

---

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
