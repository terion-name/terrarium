---
layout: home

hero:
  name: Terrarium
  text: Real VPS environments for agents, dev tools, and messy apps
  tagline: Give each workload its own hardened LXC container, keep it private by default behind NAT, publish only what you mean, and rewind mistakes in small ZFS-backed steps.
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
  - title: Private by default
    details: Containers sit behind LXD NAT, so random scans and inbound internet noise do not hit them directly. A service only becomes public when you expose it.
  - title: Rewind instead of rebuild
    details: ZFS snapshots give you small-step rollback for broken agents, failed upgrades, and experiments that went sideways.
  - title: Publish only what matters
    details: Put apps behind Traefik with TLS and optional OIDC, while databases, Redis, admin ports, and internal APIs stay private inside the container.
  - title: Real environments, not toy sandboxes
    details: Run OpenClaw, Hermes, VSCodium, Docker Compose stacks, and other workloads that need packages, services, shells, and background processes.
---

<div class="terrarium-home-grid">
  <section class="terrarium-panel terrarium-panel-accent">
    <p class="terrarium-eyebrow">Why people use it</p>
    <h2>One VPS, many isolated environments, much less regret.</h2>
    <p>
      Terrarium is for people who want to give agents and development tools room to operate without
      turning the whole host into a shared blast radius. Each workload gets a real container. The host
      stays hardened. Recovery stays fast.
    </p>
  </section>

  <section class="terrarium-panel">
    <p class="terrarium-eyebrow">What changes</p>
    <ul class="terrarium-checklist">
      <li>Agent breaks an environment: roll it back.</li>
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
  <a class="terrarium-card" href="/guides/openclaw">
    <strong>OpenClaw</strong>
    <span>Give it a real environment and keep risky experimentation away from the host.</span>
  </a>
  <a class="terrarium-card" href="/guides/hermes">
    <strong>Hermes</strong>
    <span>Run agent services in their own container and expose only the UI or API you actually want public.</span>
  </a>
  <a class="terrarium-card" href="/guides/vscode">
    <strong>VSCodium Web</strong>
    <span>Spin up browser-accessible coding environments with custom packages, isolated filesystems, and proxy-based access.</span>
  </a>
  <a class="terrarium-card" href="/guides/compose">
    <strong>Compose stacks</strong>
    <span>Keep multi-service apps together inside one rewindable LXC instead of tangling them into the host Docker setup.</span>
  </a>
</div>

## What Terrarium installs

Terrarium provisions the host with:

- [Cockpit](https://github.com/cockpit-project/cockpit)
- [`45Drives/cockpit-zfs`](https://github.com/45Drives/cockpit-zfs)
- [`45Drives/cockpit-S3ObjectBroswer`](https://github.com/45Drives/cockpit-S3ObjectBroswer)
- [LXD](https://github.com/canonical/lxd) with the built-in web UI
- [OpenZFS](https://github.com/openzfs/zfs)
- [`sanoid` and `syncoid`](https://github.com/jimsalterjrs/sanoid)
- [Traefik](https://github.com/traefik/traefik)
- [oauth2-proxy](https://github.com/oauth2-proxy/oauth2-proxy)
- Optional self-hosted [ZITADEL](https://github.com/zitadel/zitadel)
- [`devsec.hardening`](https://github.com/dev-sec/ansible-collection-hardening)

## Start here

<div class="terrarium-cards terrarium-cards-tight">
  <a class="terrarium-card" href="/getting-started/">
    <strong>Getting Started</strong>
    <span>Install flow, storage strategy, domains, and identity provider choices.</span>
  </a>
  <a class="terrarium-card" href="/security">
    <strong>Security Model</strong>
    <span>Why private-by-default networking and explicit exposure matter so much here.</span>
  </a>
  <a class="terrarium-card" href="/providers/">
    <strong>Provider Guides</strong>
    <span>How to create the VPS correctly on DigitalOcean, Vultr, Hetzner, or Hostinger.</span>
  </a>
  <a class="terrarium-card" href="/reference/terrariumctl">
    <strong>terrariumctl Reference</strong>
    <span>The full command surface for install, reconfiguration, backup, restore, and proxy sync.</span>
  </a>
</div>
