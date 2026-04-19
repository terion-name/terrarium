# Services and Endpoints

This page collects the most important host services, public endpoints, and runtime paths.

## Host Services

Terrarium provisions the host with:

- [Cockpit](https://github.com/cockpit-project/cockpit) with [cockpit-zfs](https://github.com/45Drives/cockpit-zfs) and [cockpit-S3ObjectBroswer](https://github.com/45Drives/cockpit-S3ObjectBroswer)
- [LXD](https://github.com/canonical/lxd)
- [OpenZFS](https://github.com/openzfs/zfs)
- [sanoid and syncoid](https://github.com/jimsalterjrs/sanoid)
- [Traefik](https://github.com/traefik/traefik) with the built-in dashboard
- [oauth2-proxy](https://github.com/oauth2-proxy/oauth2-proxy)
- Optional self-hosted [ZITADEL](https://github.com/zitadel/zitadel)
- [devsec.hardening](https://github.com/dev-sec/ansible-collection-hardening)

## Default Public Endpoints

- `https://manage.<dashed-public-ip>.traefik.me`
- `https://proxy.<dashed-public-ip>.traefik.me`
- `https://lxd.<dashed-public-ip>.traefik.me`
- `https://auth.<dashed-public-ip>.traefik.me` when local ZITADEL is enabled

These can be overridden with:

- `--domain`
- `--manage-domain`
- `--proxy-domain`
- `--lxd-domain`
- `--auth-domain`

## Authentication Summary

- SSH: key-only
- Cockpit: OIDC gate through `oauth2-proxy`, then local PAM login
- LXD: native OIDC plus Terrarium-managed group mapping
- Published app routes: optional OIDC gate through `@auth` or `@auth:group1,group2`

## Runtime Paths

- repo checkout: `/opt/terrarium`
- persisted config: `/etc/terrarium/config.yaml`
- secrets: `/etc/terrarium/secrets`
- general state: `/var/lib/terrarium`
- oauth2-proxy runtime: `/var/lib/terrarium/oauth2-proxy`
- route-auth oauth2-proxy runtime: `/var/lib/terrarium/oauth2-proxy-routes`
- S3 catalog: `/var/lib/terrarium/catalog`
- last exported snapshots: `/var/lib/terrarium/lastsnapshots`
- restore workspace: `/var/lib/terrarium/restore`
