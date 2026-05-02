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
- Open vSwitch/OVN for the Terrarium LXD workload network
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
- Published app routes: optional OIDC gate through `@auth` or `@auth:group1,group2` on HTTP(S) routes under the Terrarium root domain; with no root domain configured, route auth is limited to the `manage` hostname

## Runtime Paths

- repo checkout: `/opt/terrarium`
- canonical config store: LXD dqlite-backed project `terrarium-system`, key `user.terrarium.config_b64`
- local config export: `/etc/terrarium/config.yaml`
- secrets: `/etc/terrarium/secrets`
- general state: `/var/lib/terrarium`
- oauth2-proxy runtime: `/var/lib/terrarium/oauth2-proxy`
- route-auth oauth2-proxy runtime: `/var/lib/terrarium/oauth2-proxy-routes`
- S3 catalog: `/var/lib/terrarium/catalog`
- last exported snapshots: `/var/lib/terrarium/lastsnapshots`

## Internal Cluster Ports

When clustering is enabled, Terrarium only opens these ports for configured
`terrarium_cluster_peer_cidrs`:

- `8443/tcp` for LXD cluster/API traffic
- `6641/tcp` for OVN northbound database traffic
- `6642/tcp` for OVN southbound database traffic
- `6081/udp` for OVN Geneve overlay traffic

Default cluster commands store exact `/32` IPv4 or `/128` IPv6 peer CIDRs.
Broad peer subnets are an explicit trust decision because every host in the
range can reach the LXD/OVN control-plane ports above.
