# Reconfiguration

Terrarium is designed to be flexible. You don't need to reinstall your server or start from scratch just because you want to change your domain name, switch your login provider, or enable off-site backups. You can reconfigure everything in place safely.

## Where Terrarium Stores Your Settings

Terrarium stores its configuration inside LXD's highly available internal database (`dqlite`). This means that if you have a cluster of servers, they all share the exact same configuration automatically.

A backup, human-readable copy of your settings is always kept at `/etc/terrarium/config.yaml`.

Whenever you run a `terrariumctl set ...` command, Terrarium updates the database, updates the text file, and then seamlessly applies the changes to your system. (It's smart enough to skip the heavy OS-hardening steps during routine updates, making reconfigurations very fast).

If you want to update Terrarium itself, use:

```bash
terrariumctl update
```

That refreshes the installed Terrarium release under `/opt/terrarium`, installs any updated Ansible collection requirements, and reapplies the saved configuration without asking the initial install questions again. If you run the interactive installer on a host that already has `/etc/terrarium/config.yaml`, it will ask whether you want to update the existing installation or intentionally reinstall from scratch.

## The Main Reconfiguration Commands

Here are the commands you'll use to change how Terrarium behaves:

- `terrariumctl set domains`
- `terrariumctl set emails`
- `terrariumctl set idp`
- `terrariumctl set s3`
- `terrariumctl set syncoid`

*(If you ever need to manually force Terrarium to re-apply its configuration across the entire host, you can run `terrariumctl reconfigure`)*

---

## Examples: How to Change Your Setup

### 1. Change Your Domain Name
Want to switch from the default `traefik.me` domain to your own custom domain? 

```bash
terrariumctl set domains example.com
```

Terrarium will automatically update Traefik, request new SSL certificates from Let's Encrypt, and update your dashboard URLs to `manage.example.com`, `lxd.example.com`, etc.

### 2. Update Your Contact / SSL Emails
If you need to change the email address used for Let's Encrypt certificates or system alerts:

```bash
terrariumctl set emails --email ops@example.com --acme-email certs@example.com
```

### 3. Switch Between Local and External Logins (IDP)
Decided you want to stop using the built-in ZITADEL login and switch to your company's Google Workspace or Auth0? 

First, securely save your new OIDC secret to a file:
```bash
install -m 600 /dev/null /root/terrarium-oidc-secret
printf '%s\n' 'super-secret' > /root/terrarium-oidc-secret
```

Then, tell Terrarium to switch to external OIDC mode:
```bash
terrariumctl set idp oidc \
  --oidc https://issuer.example.com \
  --oidc-client terrarium \
  --oidc-secret-file /root/terrarium-oidc-secret \
  --admin-group terrarium-admins
```
Terrarium will automatically test the connection to your new provider before applying the changes to ensure you don't accidentally lock yourself out.

*(Want to switch back to the built-in ZITADEL login? Just run `terrariumctl set idp local`)*

### 4. Enable S3 Disaster Recovery Backups
Ready to start automatically exporting your ZFS snapshots to an off-site S3 bucket?

Securely save your S3 secret key:
```bash
install -m 600 /dev/null /root/terrarium-s3-secret
printf '%s\n' 'replace-with-real-secret' > /root/terrarium-s3-secret
```

Then enable S3 exports:
```bash
terrariumctl set s3 \
  --enable \
  --s3-endpoint https://nbg1.your-objectstorage.com \
  --s3-bucket terrarium-backups \
  --s3-region eu-central \
  --s3-access-key YOUR_ACCESS_KEY \
  --s3-secret-key-file /root/terrarium-s3-secret
```
Terrarium will verify the credentials by uploading and deleting a test file before saving the configuration.

### 5. Enable Syncoid Replication
If you have a second ZFS server and want to continuously mirror your snapshots to it:

```bash
terrariumctl set syncoid \
  --enable \
  --syncoid-target root@backup-host \
  --syncoid-target-dataset backup/terrarium \
  --syncoid-ssh-key /root/.ssh/id_ed25519
```

---

## What Actually Happens When You Reconfigure?

Terrarium is designed to be non-disruptive. When you change a setting:
- Traefik routing changes trigger a graceful Traefik restart.
- IDP changes re-render and restart the `oauth2-proxy` without dropping active container traffic.
- ZITADEL settings are updated inside the `terrarium-idp` container.
- Terrarium automatically runs `terrariumctl proxy sync` to ensure all your published apps reflect the new domains and authentication rules.
