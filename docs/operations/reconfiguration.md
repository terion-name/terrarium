# Reconfiguration

Terrarium is meant to be changed in place. You do not reinstall the host every time you want to update a domain, change the IDP, or enable S3.

## Where Terrarium Stores State

- repo checkout: `/opt/terrarium`
- persisted config: `/etc/terrarium/config.yaml`

`terrariumctl set ...` updates the persisted config and then runs local reconciliation.

## Main Reconfiguration Commands

- `terrariumctl set domains`
- `terrariumctl set emails`
- `terrariumctl set idp`
- `terrariumctl set s3`
- `terrariumctl set syncoid`

There is also:

- `terrariumctl reconfigure`

That re-runs the local Ansible reconciliation using the current saved config.

## What Gets Updated On Change

- Traefik config changes trigger a Traefik restart
- `oauth2-proxy` is rendered and restarted when IDP, admin-group, or management-domain settings change
- LXD domain, ACME, OIDC issuer/client settings, and IdP group mappings are applied directly through `lxc config set` and `lxc auth`
- self-hosted ZITADEL is enabled, disabled, or restarted when its rendered config changes
- Terrarium then re-runs `terrariumctl proxy sync`
- when IDP mode is `local`, Terrarium also re-runs `terrariumctl idp sync`

## Typical Changes

### Change Domains

```bash
terrariumctl set domains example.com
```

Optional overrides:

- `--manage-domain`
- `--lxd-domain`
- `--auth-domain`

### Change Email Settings

```bash
terrariumctl set emails --email ops@example.com --acme-email certs@example.com
```

### Switch Between Local And External IDP

Local ZITADEL:

```bash
terrariumctl set idp local
```

External OIDC:

```bash
terrariumctl set idp oidc \
  --oidc https://issuer.example.com \
  --oidc-client terrarium \
  --oidc-secret 'super-secret' \
  --admin-group terrarium-admins
```

### Enable S3 Backups

```bash
terrariumctl set s3 \
  --enable \
  --s3-endpoint https://nbg1.your-objectstorage.com \
  --s3-bucket terrarium-backups \
  --s3-region eu-central \
  --s3-access-key ... \
  --s3-secret-key ...
```

### Enable Syncoid

```bash
terrariumctl set syncoid \
  --enable \
  --syncoid-target root@backup-host \
  --syncoid-target-dataset backup/terrarium \
  --syncoid-ssh-key /root/.ssh/id_ed25519
```
