# Protecting Published Services with OIDC

Some services you run in Terrarium have good built-in auth. Some have awkward auth. Some have effectively none.

Examples:

- `VSCodium serve-web` uses a static connection token
- internal dashboards sometimes only support a shared password
- small developer tools often ship with no auth at all
- some services should not be public in the first place and should stay private

This guide explains the Terrarium pattern for protecting routes with OIDC, using Traefik on the host, `oauth2-proxy` as the auth bridge, and ZITADEL or another OIDC provider as the identity provider.

## What to use when

Use the service's own auth when:

- the service already has strong user accounts, SSO, or role-based auth
- you are comfortable managing auth inside that app

Keep the service private when:

- it is meant only for you
- it is admin-only or especially dangerous
- you can access it through SSH, Tailscale, or an LXD shell instead of the public web

Add host-level OIDC protection when:

- the service has no auth or weak auth
- the service uses an awkward shared secret or static token
- you want one consistent sign-in flow across several apps

## Recommended architecture

The simplest host-side architecture for Terrarium is:

1. One shared `oauth2-proxy` instance on the host
2. Traefik `ForwardAuth` middleware in front of selected routes
3. ZITADEL as the OIDC issuer

Why this is simpler than a second full proxy layer per app:

- Traefik already owns routing and TLS on the host
- `oauth2-proxy` already documents Traefik `ForwardAuth` integration officially
- one shared `oauth2-proxy` instance can protect many routes
- you only need one OIDC client in ZITADEL if the callback domain stays the same

This is the model Terrarium now uses for management access.

## What Terrarium automates today

Terrarium already automates this pattern for the management surface:

- Cockpit is protected by host-level `oauth2-proxy`
- Traefik uses `ForwardAuth` on `manage.<domain>`
- the callback stays on the same domain at `https://manage.<domain>/oauth2/callback`
- self-hosted ZITADEL auto-provisions the needed OIDC application, admin role, and group claim plumbing
- external OIDC works too, as long as your provider emits a `groups` claim and your external client is configured with the Terrarium callback URLs

Terrarium now also automates published-route auth for HTTP(S) `user.proxy` labels:

- `https://code.example.com:3000@auth`
- `https://hermes.example.com:8642@auth:agents,admins`

Meaning:

- `@auth` requires any authenticated user
- `@auth:group1,group2` requires membership in at least one listed group

Current limitation:

- published-route auth currently works only for hosts on the Terrarium root domain or its subdomains, because the shared callback lives at `https://manage.<domain>/oauth2/app/callback`

## ZITADEL: local vs cloud

### Local ZITADEL on Terrarium

If you installed Terrarium with `--idp=local`, your issuer is already on the host, usually at:

```text
https://auth.<your-domain>
```

This is the easiest path for Terrarium-wide protection because:

- the auth domain already lives on your root domain
- you control it fully
- there is no cloud plan restriction around custom domains

### ZITADEL Cloud

ZITADEL Cloud's free tier is enough for personal use according to the current pricing page:

- `US$0/month`
- `100 Daily Active Users`
- `3 identity providers`

That is enough for a personal Terrarium setup.

But there is one important catch: custom domain support is listed on the `PRO` plan, not the free tier.

So on the free cloud plan:

- use your default ZITADEL Cloud issuer domain
- do **not** expect `auth.<your-domain>` there

That still works fine with `oauth2-proxy`. Your protected apps can live on your own domain while the issuer stays on the ZITADEL Cloud domain.

## Exact ZITADEL setup

The clean model is to create **one shared web application** for the host's `oauth2-proxy`.

Example hostnames:

- issuer: `https://auth.example.com` for self-hosted, or `https://<tenant>.<region>.zitadel.cloud` for cloud
- `oauth2-proxy` callback on the management domain: `https://manage.example.com/oauth2/callback`
- published-route auth callback on the management domain: `https://manage.example.com/oauth2/app/callback`

In ZITADEL:

1. Open your project, or create a dedicated project such as `terrarium-proxy`.
2. Add a new application.
3. Choose `Web Application`.
4. Choose `Authorization Code`.
5. Set `Authentication Method` to `BASIC`.
6. Add this redirect URI:

```text
https://manage.example.com/oauth2/callback
```

7. Add this redirect URI too if you want to protect published app routes:

```text
https://manage.example.com/oauth2/app/callback
```

8. Optionally add a post-logout URI such as:

```text
https://manage.example.com/
```

9. Create the app and save the generated client ID and secret.

This exact app shape is what ZITADEL documents for `oauth2-proxy`.

## What has to change in ZITADEL when you protect new domains

If you keep one shared `oauth2-proxy` application for the management surface, then adding new management hostnames on the same callback host does not require a new ZITADEL application. For example:

- `https://manage.example.com`
- `https://manage.example.net`

If you later add app-level route protection for published services, a separate shared callback host may still be the cleaner long-term design.

That is the key ergonomics win of the shared-proxy model.

You only need to change ZITADEL when:

- you create the `oauth2-proxy` app for the first time
- you change the management callback host from `manage.example.com` to something else
- you rotate the client secret
- you start doing role or group-based authorization and need matching claims in the token

## Exact oauth2-proxy configuration shape

The official ZITADEL example for `oauth2-proxy` uses the generic OIDC provider. For Terrarium, the shared host-side config should look roughly like this:

```toml
provider = "oidc"
provider_display_name = "ZITADEL"
oidc_issuer_url = "https://auth.example.com"
redirect_url = "https://manage.example.com/oauth2/callback"
http_address = "127.0.0.1:4180"
reverse_proxy = true
upstreams = ["static://202"]
email_domains = ["*"]
client_id = "replace-with-zitadel-client-id"
client_secret = "replace-with-zitadel-client-secret"
cookie_secret = "replace-with-32-byte-secret"
cookie_secure = true
cookie_domains = ["manage.example.com"]
whitelist_domains = ["manage.example.com"]
oidc_groups_claim = "groups"
allowed_groups = ["terrarium-admins"]
scope = "openid profile email"
set_xauthrequest = true
skip_provider_button = true
pass_access_token = false
```

Why this shape:

- `reverse_proxy = true` is required for the documented Traefik integration
- `upstreams = ["static://202"]` is the documented pattern for Traefik `ForwardAuth` without a second upstream proxy hop
- `cookie_domains = ["manage.example.com"]` keeps the management auth cookie scoped to Cockpit
- `http_address = "127.0.0.1:4180"` keeps `oauth2-proxy` private on the host
- `allowed_groups` plus `oidc_groups_claim = "groups"` is how Terrarium separates server-management access from app access

## Why ForwardAuth is the simpler Traefik mode

`oauth2-proxy` documents two Traefik patterns:

1. `ForwardAuth` plus Traefik `errors` middleware
2. `ForwardAuth` with a static upstream configuration, where unauthenticated users get redirected without the extra errors middleware

For Terrarium, the second pattern is simpler.

That means:

- Traefik keeps the real backend routing
- `oauth2-proxy` only answers the auth check
- you do not need a full second reverse proxy layer in front of each app

## Route protection model Terrarium uses now

Terrarium keeps auth with the route itself, not in a second disconnected config file.

Current syntax:

```bash
lxc config set devbox user.proxy "https://code.example.com:8080@auth"
lxc config set hermes user.proxy "https://hermes.example.com:8642@auth:admins"
```

That label remains the source of truth. `terrariumctl proxy sync` reads it, renders Traefik middlewares, and reconciles the host-side oauth2-proxy route-auth stack automatically.

## Group and role restrictions

If you want "signed in" to be enough, the shared OIDC client is all you need.

If you want route-level authorization like "only admins may open this route", `oauth2-proxy` supports group restrictions, but ZITADEL documents that you need to add an Action to complement the token with the group or role claim you want to check.

Terrarium now supports both:

- `@auth`
- `@auth:admins,devops`

## Practical recommendation

For management auth today:

- use Terrarium's built-in Cockpit protection
- let Terrarium manage the shared `oauth2-proxy` instance
- in local mode, rely on the auto-provisioned `terrarium-admins` role unless you need a different group name
- in external mode, make sure your external client allows:
  - `https://manage.<domain>/oauth2/callback`
  - `https://lxd.<domain>/oidc/callback`
  and emits a `groups` claim that contains your configured admin group

For published app routes:

- keep especially sensitive tools private unless they really need to be public
- rely on strong built-in auth where available
- use `@auth` when “signed in is enough”
- use `@auth:group1,group2` when a route should be limited to specific IdP groups

The next useful Terrarium improvement would be helper commands that edit `user.proxy` labels for the user instead of requiring manual string edits.

## Upstream docs used for this guide

- [OAuth2 Proxy Traefik integration](https://oauth2-proxy.github.io/oauth2-proxy/next/configuration/integrations/traefik/)
- [OAuth2 Proxy installation](https://oauth2-proxy.github.io/oauth2-proxy/installation)
- [OAuth2 Proxy provider configuration](https://oauth2-proxy.github.io/oauth2-proxy/7.8.x/configuration/providers/)
- [OAuth2 Proxy endpoints and sign-out behavior](https://oauth2-proxy.github.io/oauth2-proxy/7.4.x/features/endpoints/)
- [Traefik ForwardAuth middleware](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/forwardauth/)
- [ZITADEL oauth2-proxy example](https://zitadel.com/docs/examples/identity-proxy/oauth2-proxy)
- [ZITADEL pricing](https://zitadel.com/pricing)
- [ZITADEL custom domain overview](https://zitadel.com/docs/concepts/features/custom-domain)
