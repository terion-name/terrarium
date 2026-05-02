# Protecting Published Services

Terrarium lets you put OIDC sign-in in front of web apps running inside LXC containers.

Use it when a service:

- has no auth at all
- only has a weak shared password or static token
- is meant for a small team, not the public internet
- should reuse the same login system as the rest of your Terrarium host

You add protection directly to the container's `user.proxy` label, and Terrarium handles the proxying, callback routing, and auth checks for you.

## The Simple Version

Use `@auth` on an HTTP(S) route when any signed-in user should be allowed in.

```bash
lxc config set my-app user.proxy "https://app.example.com:3000@auth"
```

Use `@auth:group1,group2` when only specific groups should be allowed in.

```bash
lxc config set admin-tool user.proxy "https://admin.example.com:8080@auth:admins,devops"
```

Then run:

```bash
terrariumctl proxy sync
```

Or just wait for the built-in sync timer.

When you add `@auth` to a route, Terrarium automatically:

- keeps Traefik in front of the container
- adds OIDC sign-in through the host's configured identity provider
- reuses the Terrarium auth stack instead of asking you to deploy your own
- handles callback routing on the protected route hostname
- applies group checks if you listed groups

So the workflow is just:

1. expose the app
2. add `@auth` or `@auth:group1,group2`
3. run `terrariumctl proxy sync`

## Syntax

Supported HTTP(S) forms:

```text
https://host[:container_port][/path]@auth
http://host[:container_port][/path]@auth
https://host[:container_port][/path]@auth:group1,group2
http://host[:container_port][/path]@auth:group1,group2
```

Meaning:

- `@auth` means any authenticated user
- `@auth:group1,group2` means the user must be in at least one listed group

Examples:

```bash
lxc config set codebox user.proxy "https://code.example.com:3000@auth"
lxc config set hermes user.proxy "https://hermes.example.com:8642@auth:agents,admins"
lxc config set dashboard user.proxy "https://dash.example.com/app@auth"
```

## Good Fits

This works well when:

- you run `VSCodium serve-web` and do not want to rely only on a static token
- you expose agent UIs like Hermes or internal dashboards
- you want a quick login gate in front of a developer tool
- you want different groups for management tools and published apps

Do not use it for raw `tcp://` or `udp://` routes. This feature is for HTTP and HTTPS only.

## Identity Provider Setup

### If you use `--idp=local`

This is the easy path. Terrarium already manages the local ZITADEL side for you.

In practice, you usually just:

```bash
lxc config set my-app user.proxy "https://app.example.com:3000@auth"
terrariumctl proxy sync
```

### If you use `--idp=oidc`

Terrarium can still protect published routes, but your external OIDC client must allow each protected route callback:

```text
https://<route-host>/oauth2/route/<generated-route-id>/callback
```

Terrarium reuses the same external OIDC client for management oauth2-proxy hosts
and route protection, so these route callbacks are additions to the normal
management callbacks for `manage` and `proxy` rather than separate apps. The
route id is deterministic for the route host and group policy. The rendered
oauth2-proxy config stores a path-only `redirect_url` so cookies stay host-only;
combine that path with the protected route host to form the full callback URL.

```bash
grep -R -E '^(redirect_url|whitelist_domains)' /var/lib/terrarium/oauth2-proxy-routes/*.cfg
```

If you use group-restricted routes, your provider must also include a `groups` claim.

One-time checklist for external OIDC:

1. set the issuer, client ID, and client secret in Terrarium
2. add each full route callback URL to your OIDC client
3. make sure your provider sends a `groups` claim if you use `@auth:group1,group2`

## Group-Based Access

Examples:

- `https://code.example.com:3000@auth`
  Anyone who can sign in is allowed through.

- `https://hermes.example.com:8642@auth:agents`
  Only members of `agents` can get in.

- `https://admin.example.com:8080@auth:admins,devops`
  Members of either `admins` or `devops` can get in.

Use groups when:

- Cockpit and LXD should stay admin-only
- internal apps should be visible to a broader team
- some apps should be limited to a specific role or project group

## Important Limitation

Published-route auth currently works only for hosts on your Terrarium root
domain or its subdomains. If no custom root domain is configured, auth-protected
routes are limited to the `manage` hostname. Route-auth cookies are still scoped
to the exact protected route host.

```text
https://<route-host>/oauth2/route/<generated-route-id>/callback
```

So routes like these are fine:

- `https://code.example.com@auth`
- `https://hermes.dev.example.com@auth:agents`

This is not a good fit:

- `https://totally-other-domain.net@auth`

For arbitrary protected app hostnames, use a real `--domain`.

## How the Callback Works

With Terrarium, the sign-in callback for a protected app lives on that app's hostname under a Terrarium-owned path:

```text
https://app.example.com/oauth2/route/<generated-route-id>/callback
```

The flow is:

1. a user opens `https://app.example.com`
2. Terrarium redirects them to sign in
3. the identity provider sends them back to `https://app.example.com/oauth2/route/<generated-route-id>/callback`
4. Terrarium finishes the login and then sends them back to the original app URL

The callback path is handled by Terrarium's route-auth oauth2-proxy, not by the app running inside the container.

## Quick Example

Expose a service on port `8080` inside the container and require login:

```bash
lxc exec my-app -- sh
# start your app on 0.0.0.0:8080 inside the container
exit

lxc config set my-app user.proxy "https://app.example.com:8080@auth"
terrariumctl proxy sync
```

Require a group on a second route:

```bash
lxc config set my-app user.proxy "https://app.example.com:8080@auth,https://admin.example.com:9090@auth:admins"
terrariumctl proxy sync
```

## Troubleshooting

If a protected route does not work:

- make sure the app inside the container listens on `0.0.0.0:<port>`
- make sure the route host is on your Terrarium root domain
- run `terrariumctl proxy sync`
- check `terrariumctl status`
- if you use external OIDC, verify that every full route callback URL is allowed in the client config
- if you use group restrictions, verify your token includes a `groups` claim with the expected group names

## Practical Advice

Start with `@auth`. Add groups only when you actually need different access levels.
