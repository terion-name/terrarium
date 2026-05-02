# Clustering

Terrarium clustering is built on LXD clustering. LXD owns the cluster
membership, dqlite replication, and instance placement; Terrarium stores its
own config in LXD's dqlite-backed project metadata and reconciles each node
from that shared config.

This gives you one LXD management plane across nodes and one Terrarium config
document. It does not automatically make every workload highly available. A
container still runs on one LXD member at a time unless you deliberately move,
restore, or design that workload around external/shared state.

## Recommended Shape

Use at least three members for a real cluster. LXD can form smaller clusters,
but three members let dqlite keep quorum after one member is lost. OVN central
members should also be an odd-sized set.

Use private addresses for the cluster network when your provider gives you a
private/VPC network. Do not expose LXD cluster port `8443`, OVN database ports
`6641`/`6642`, or OVN Geneve traffic `6081/udp` to the public internet.

## Bootstrap The First Member

Install Terrarium on the first node normally, then enable LXD clustering:

```bash
terrariumctl cluster init
```

What this does:

- uses the host shortname as the LXD member name
- auto-selects a reachable non-container host address for LXD port `8443`
- prefers a private/VPC address when one exists
- opens LXD/OVN firewall rules only for exact cluster peer addresses
- configures this node as the first OVN central member
- sets LXD's reachable cluster API listener
- enables LXD clustering on the local server
- stores Terrarium cluster/OVN settings in the shared config
- runs Terrarium reconfiguration so OVN, firewall rules, and profiles converge

If your hosts only have public addresses, Terrarium still does not guess a
broad public firewall range. Pass exact peers explicitly, or preferably add a
private provider network first:

```bash
terrariumctl cluster init --peer-cidr 203.0.113.12/32
```

All discovery can be overridden when needed:

```bash
terrariumctl cluster init \
  --member node1 \
  --address 10.0.0.11:8443 \
  --central-addresses 10.0.0.11,10.0.0.12,10.0.0.13 \
  --peer-cidr 10.0.0.12/32,10.0.0.13/32
```

`--peer-cidr` is a firewall trust boundary. It controls which source addresses
may reach LXD `8443/tcp`, OVN database ports `6641/tcp`/`6642/tcp`, and OVN
Geneve `6081/udp`. Prefer exact `/32` IPv4 or `/128` IPv6 peer addresses.
For convenience, Terrarium accepts plain peer IPs and stores them as exact
CIDRs.
Only pass a subnet such as `10.0.0.0/24` when every host in that subnet is
trusted to reach the cluster control plane.

## Join Additional Members

On an existing cluster member, create an invite:

```bash
terrariumctl cluster invite node2
```

The command pre-opens this member's firewall for the joining node when `node2`
resolves to an IP address. If the name is not resolvable, Terrarium asks for
the joining node's address in interactive terminals. For automation, pass the
joining node's exact address:

```bash
terrariumctl cluster invite node2 10.0.0.12
```

`cluster invite` reads the LXD token expiry and schedules a one-shot systemd
timer to clean up temporary exact peer firewall rules after that expiry. If the
node joins before the token expires, cleanup sees the new LXD member and keeps
the peer rule. If the node never joins, cleanup removes the exact peer rule
from UFW and from the shared Terrarium config. Broad explicit CIDRs are treated
as operator-managed trust boundaries and are not auto-cleaned.

The command prints the join command to run on the new node:

```bash
terrariumctl cluster join --token '<token-from-existing-member>'
```

Joining an LXD cluster replaces the node's local LXD database. Use fresh nodes
or nodes whose local instances have already been backed up or moved.

When `--address` is omitted, Terrarium routes toward the existing member in the
token and uses the local source address as the new member address. When
`--peer-cidr` is omitted, Terrarium pre-opens exact firewall rules for the
existing member addresses embedded in the token. After join, Terrarium exports
the shared config from the LXD dqlite-backed store to
`/etc/terrarium/config.yaml` and runs `terrariumctl reconfigure` on that node.

For public-only clusters, pass exact public peer CIDRs on both sides:

```bash
terrariumctl cluster init --peer-cidr 203.0.113.12/32
terrariumctl cluster join --token '<token>' --peer-cidr 203.0.113.11/32 --yes
```

## OVN Networking

Terrarium creates an OVN workload network named `terrarium-ovn` and points the
`default`, `terrarium`, and `strict` profiles at it. The existing managed bridge
`lxdbr0` remains as the parent/uplink network.

Default network values:

- parent/uplink network: `lxdbr0`
- workload network: `terrarium-ovn`
- parent subnet: `10.154.0.1/24`
- DHCP range: `10.154.0.2-10.154.0.199`
- OVN router range: `10.154.0.200-10.154.0.254`

Terrarium's reverse proxy runs on the host. For OVN-backed containers,
`terrariumctl proxy sync` creates host-loopback LXD `proxy` devices for
published container backends and points Traefik at those localhost listeners.
This avoids relying on direct host reachability to private OVN instance
addresses.

## Traefik And Published Routes

Traefik is deployed on every Terrarium node. Each node also runs
`terrariumctl proxy sync` locally through the Terrarium sync timer. The sync
reads LXD cluster state, renders that node's local Traefik dynamic config, and
creates local host-loopback LXD `proxy` devices for published container
backends.

That means every healthy node can serve the same published routes. If a
workload is running on `node2`, Traefik on `node1` still points at a local
listener on `127.0.0.1`; LXD's proxy device and OVN/LXD cluster networking
carry the traffic to the actual workload member. Operators do not need to
manually keep Traefik route files in sync between nodes.

For simple ingress distribution, put all node public IPs in the same DNS record
set:

```text
app.example.com.  A  203.0.113.10
app.example.com.  A  203.0.113.11
app.example.com.  A  203.0.113.12
```

This is round-robin DNS, not health-aware failover. If a node is down, some
clients can still receive or cache that node's IP. For production-grade
failover, place a health-checked load balancer, health-checked DNS service,
floating IP automation, anycast/BGP setup, or provider load balancer in front
of the Terrarium nodes.

To update OVN central members or peer firewall peers after the cluster exists,
run:

```bash
terrariumctl cluster ovn configure
```

Without flags, Terrarium reads LXD cluster membership, keeps an odd-sized OVN
central set, and writes exact member CIDRs to the shared peer firewall list. Use
explicit flags when you want a specific central set or a deliberately broader
trusted peer network:

```bash
terrariumctl cluster ovn configure \
  --central-addresses 10.0.0.11,10.0.0.12,10.0.0.13 \
  --peer-cidr 10.0.0.11/32,10.0.0.12/32,10.0.0.13/32
```

Use an odd number of OVN central addresses. Terrarium starts `ovn-central` on
members whose local address is in that list, runs `ovn-host` everywhere, points
Open vSwitch at the shared southbound database, and sets LXD's OVN northbound
connection.

`cluster ovn configure` reconciles the node where you run it. Existing members
read the same shared config, but they still need `terrariumctl reconfigure` if
you changed the central set after they had already joined.

## Moving Workloads And Removing Members

Move one workload to another member:

```bash
terrariumctl cluster move app1 node2
```

This wraps LXD's cluster-aware `lxc move` operation and keeps the workload name
unchanged. If LXD cannot migrate a running workload in your environment, stop
the workload first or use the removal flow below, which handles stop/move/start
for you.

For planned maintenance, evacuate a member instead of removing it:

```bash
terrariumctl cluster evacuate node2
# perform maintenance
terrariumctl cluster restore node2
```

Evacuation asks LXD to move workloads away according to their configured
evacuation behavior. Restore makes the member eligible for workloads again; it
does not promise to move the same workloads back automatically. Both commands
ask for confirmation; add `--yes` for automation:

```bash
terrariumctl cluster evacuate node2 --yes
terrariumctl cluster restore node2 --yes
```

For permanent decommission, remove the member from another healthy member:

```bash
terrariumctl cluster remove node2
```

If workloads still exist on `node2`, Terrarium asks whether to move them before
removing the member. In automation, use:

```bash
terrariumctl cluster remove node2 --move --yes
```

When `--target` is omitted, Terrarium creates a best-effort distribution plan
across the remaining online members. It prefers members with fewer existing
workloads, and uses lower memory pressure as a tie-breaker when LXD reports
resource data. Add `--target node1` when you intentionally want every workload
to land on one member.

For this removal flow, running workloads are stopped, moved, and started again
on the target member. If you need zero-downtime behavior, design that at the
application layer or use LXD evacuation settings that match the workload.

If a member is dead and cannot be drained, use force removal:

```bash
terrariumctl cluster remove node2 --force
```

Force removal only removes the member from LXD cluster metadata. Workloads that
only existed on that member's local storage are not recovered automatically;
restore them from Terrarium backups, replicated storage, or another external
recovery path.

## Useful Commands

```bash
terrariumctl cluster status
terrariumctl cluster invite node3
terrariumctl cluster move app1 node2
terrariumctl cluster evacuate node2 --yes
terrariumctl cluster restore node2 --yes
terrariumctl cluster remove node2
terrariumctl cluster token node3
terrariumctl config export
terrariumctl reconfigure
```

`terrariumctl cluster status` is a thin view over LXD cluster state plus the
Terrarium OVN network. Use native LXD commands such as `lxc cluster list`,
`lxc list`, and `lxc launch ... --target <member>` for lower-level placement
and troubleshooting.

## Limits

Current Terrarium clustering intentionally stops at safe primitives:

- LXD membership is token-based and still follows LXD's fresh-node rules.
- Terrarium config is replicated through LXD dqlite project metadata.
- New containers use OVN networking so instances on different members can share
  the same logical network.
- ZFS storage is still local to each member unless you separately add shared or
  replicated storage workflows.
- Traefik, Cockpit, ZITADEL, and backup timers are reconciled locally on each
  node; public entrypoint failover is a separate load-balancing/DNS decision.
