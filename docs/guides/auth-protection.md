# Protecting Published Services with SSO

One of Terrarium's most powerful features is the ability to easily lock your web apps behind a Single Sign-On (SSO) gate. 

You don't need to write custom authentication code, deploy a separate identity proxy, or mess with Nginx configs. You just add a tiny label to your container, and Terrarium handles the rest.

This is perfect for:
- Self-hosted admin dashboards (like Pi-hole or Grafana).
- Internal company tools that shouldn't be public.
- Web IDEs (like VSCodium) where you want an extra layer of security.
- AI Agent web interfaces (like OpenClaw or Hermes).

---

## How It Works: The Magic `@auth` Tag

To expose an app to the public internet, you normally add a `user.proxy` label like this:
```bash
lxc config set my-app user.proxy "https://app.example.com:3000"
```

**To lock that app behind SSO, just append `@auth` to the end of the URL.**

```bash
lxc config set my-app user.proxy "https://app.example.com:3000@auth"
terrariumctl proxy sync
```

That's literally it. Now, whenever someone visits `app.example.com`, they will be redirected to your Terrarium login page (either ZITADEL or your external provider like Google). Only authenticated users will be allowed through to see the app.

---

## Restricting Access to Specific Groups

What if you have a team of people, but you only want your developers to access a specific app?

You can restrict access to specific groups by appending `:groupname` to the auth tag.

```bash
lxc config set admin-tool user.proxy "https://admin.example.com:8080@auth:admins,devops"
terrariumctl proxy sync
```
In this example, a user must successfully log in **AND** belong to either the `admins` or `devops` group to gain access. 

*(If you're using Terrarium's built-in ZITADEL login, you can create these groups right inside the `auth.<your-domain>` dashboard.)*

---

## Important Rules for External OIDC

If you installed Terrarium using `--idp=local`, everything above works instantly. Terrarium manages all the wiring for you.

However, if you configured Terrarium to use an **External Identity Provider** (like Auth0, Google, or GitHub), there is one extra step you must do manually.

When Terrarium creates a protected route, it generates a unique "Callback URL" that your identity provider needs to know about. 

**1. Find the generated callback URLs:**
```bash
grep -R -E '^(redirect_url)' /var/lib/terrarium/oauth2-proxy-routes/*.cfg
```

**2. Add them to your Provider:**
You must log into your Auth0/Google/GitHub developer console and add that exact callback URL to your authorized redirect list. Otherwise, the login flow will fail.

**3. Group Claims:**
If you are using the `@auth:groupname` feature, you must also ensure your external provider is configured to send a `groups` claim inside the authentication token, or Terrarium won't know which groups the user belongs to.

---

## Troubleshooting

If you add an `@auth` tag and the site stops loading, check these common culprits:
1. **Did you run the sync command?** Always run `terrariumctl proxy sync` after changing a proxy label.
2. **Is your app listening on `0.0.0.0`?** The app inside your container must listen on all interfaces, not just `127.0.0.1`, so Terrarium's proxy can reach it.
3. **Are you using a custom domain?** Route protection currently only works for URLs that match your Terrarium root domain (e.g., if your server is `example.com`, you can protect `app.example.com`, but not `totally-different-domain.com`).