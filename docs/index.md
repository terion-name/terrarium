---
layout: home

hero:
  name: Terrarium
  text: Real VPS environments for agents, development, and workloads
  tagline: Transform any VPS into a secure host with isolated environments for your agents, development, and workloads. Time machine included.
  image:
    src: /banner.webp
    alt: Terrarium banner
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/
    - theme: alt
      text: See Guides
      link: /guides/
    - theme: alt
      text: Understand Security
      link: /security

features:
  - title: 🔐 Harden the host
    details: Terrarium secures the VPS itself first, with SSH hardening and safer defaults, so your management surface is not a raw fresh-server free-for-all.
  - title: 🤖 Real agent environments
    details: Run OpenClaw, Hermes, VSCodium, Compose stacks, and other workloads that need packages, services, shells, and background processes.
  - title: 🛡️ Private by default
    details: Containers sit behind LXD NAT, so random scans and inbound internet noise do not hit them directly. A service only becomes public when you expose it.
  - title: ⏪ Built-in time machine
    details: ZFS snapshots let you roll environments backward in small steps, and S3 exports give you disaster recovery when the whole VPS is gone.
  - title: 🌐 Publish only what matters
    details: Put apps behind Traefik with TLS and optional OIDC, while databases, Redis, admin ports, and internal APIs stay private inside the container.
  - title: 🖥️ Built-in management UIs
    details: Cockpit, the LXD UI, and the Traefik dashboard give you a visual control plane instead of forcing everything through the terminal.
---

<div class="terrarium-home-grid">
  <section class="terrarium-panel terrarium-panel-accent">
    <p class="terrarium-eyebrow">Why people use it</p>
    <h2>One VPS, many isolated environments, much less regret.</h2>
    <p>
      Terrarium is for people who want to give agents and development tools room to operate without
      turning the whole host into a shared blast radius. Each workload gets a real container. The host
      stays hardened. Recovery gets a built-in time machine.
    </p>
  </section>

  <section class="terrarium-panel">
    <p class="terrarium-eyebrow">What changes</p>
    <ul class="terrarium-checklist">
      <li>Agent breaks an environment: step back through snapshots instead of rebuilding from scratch.</li>
      <li>Compose stack needs Postgres, Redis, workers, and dashboards: keep them inside one private LXC.</li>
      <li>Browser IDE or internal UI needs public access: publish it through Traefik and protect it with OIDC.</li>
    </ul>
  </section>
</div>

## Why Terrarium feels safer

The most important part is not flashy, but it changes how comfortable the whole system feels.

Containers are not exposed directly to the internet. They sit behind LXD's private bridge and NAT, which means:

- random scans and probes do not hit them directly
- a service listening on `0.0.0.0` inside the container is still not automatically public
- complex stacks can keep internal services private even when one frontend is exposed

That is why Terrarium works so well for non-experts. You can run a lot inside a container without accidentally publishing all of it.

## Good fits

<div class="terrarium-cards">
  <a class="terrarium-card" href="./guides/openclaw">
    <strong>OpenClaw</strong>
    <span>Give it a real environment and keep risky experimentation away from the host.</span>
  </a>
  <a class="terrarium-card" href="./guides/hermes">
    <strong>Hermes</strong>
    <span>Run agent services in their own container and expose only the UI or API you actually want public.</span>
  </a>
  <a class="terrarium-card" href="./guides/vscode">
    <strong>VSCodium Web</strong>
    <span>Spin up browser-accessible coding environments with custom packages, isolated filesystems, and proxy-based access.</span>
  </a>
  <a class="terrarium-card" href="./guides/compose">
    <strong>Compose stacks</strong>
    <span>Keep multi-service apps together inside one time-machine-enabled LXC instead of tangling them into the host Docker setup.</span>
  </a>
</div>

<div class="terrarium-home-grid terrarium-home-grid-equal terrarium-home-grid-sections">
  <section class="terrarium-panel">
    <p class="terrarium-eyebrow">Management without memorizing everything</p>
    <h2>Use the host visually when you want to.</h2>
    <p>
      Terrarium is friendly to terminal users, but it is also practical for people who do not want to
      manage a whole host from raw commands alone.
    </p>
    <ul class="terrarium-checklist">
      <li><strong>Cockpit</strong> for host administration, logs, terminal access, and ZFS-oriented extensions.</li>
      <li><strong>LXD UI</strong> for creating and managing containers, profiles, networks, and snapshots.</li>
      <li><strong>Traefik dashboard</strong> for understanding the live routing layer.</li>
    </ul>
    <p>If you want the visual tour, start with <a href="./getting-started/management-guis">Management GUIs</a>.</p>
  </section>

  <section class="terrarium-panel">
    <p class="terrarium-eyebrow">What Terrarium installs</p>
    <h2>Everything needed to turn a plain VPS into a safer control plane.</h2>
    <ul class="terrarium-checklist">
      <li><a href="https://github.com/cockpit-project/cockpit">Cockpit</a> with <a href="https://github.com/45Drives/cockpit-zfs">cockpit-zfs</a> and <a href="https://github.com/45Drives/cockpit-S3ObjectBroswer">cockpit-S3ObjectBroswer</a></li>
      <li><a href="https://github.com/canonical/lxd">LXD</a> with the built-in web UI</li>
      <li><a href="https://github.com/openzfs/zfs">OpenZFS</a></li>
      <li><a href="https://github.com/jimsalterjrs/sanoid">sanoid and syncoid</a></li>
      <li><a href="https://github.com/traefik/traefik">Traefik</a> with the built-in dashboard</li>
      <li><a href="https://github.com/oauth2-proxy/oauth2-proxy">oauth2-proxy</a></li>
      <li>Optional self-hosted <a href="https://github.com/zitadel/zitadel">ZITADEL</a></li>
      <li><a href="https://github.com/dev-sec/ansible-collection-hardening">devsec.hardening</a></li>
    </ul>
  </section>
</div>

## Start here

<div class="terrarium-cards terrarium-cards-tight">
  <a class="terrarium-card" href="./getting-started/">
    <strong>Getting Started</strong>
    <span>Install flow, storage strategy, domains, and identity provider choices.</span>
  </a>
  <a class="terrarium-card" href="./security">
    <strong>Security Model</strong>
    <span>Why private-by-default networking and explicit exposure matter so much here.</span>
  </a>
  <a class="terrarium-card" href="./getting-started/management-guis">
    <strong>Management GUIs</strong>
    <span>See what Cockpit, the LXD UI, and the Traefik dashboard are each good for.</span>
  </a>
  <a class="terrarium-card" href="./providers/">
    <strong>Provider Guides</strong>
    <span>How to create the VPS correctly on DigitalOcean, Vultr, Hetzner, or Hostinger.</span>
  </a>
  <a class="terrarium-card" href="./reference/terrariumctl">
    <strong>terrariumctl Reference</strong>
    <span>The full command surface for install, reconfiguration, backup, restore, and proxy sync.</span>
  </a>
</div>
