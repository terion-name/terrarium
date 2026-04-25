* plugins job to check released versions
* cluster mode with ovn
* config in dqlite
* docs guide: dokploy
* openclaw and hermes guide advanced addition: add memories and artifacts data storing on storage box
* remove `terrarium profile`, add `kvm` profile

## Smoke stabilization review queue

- [x] P1: Fix route group authorization generation so `@auth:group` creates oauth2-proxy configs with enforced `allowed_groups` instead of passing policy via a Traefik query string.
- [x] P1: Make denied-route browser assertions fail immediately when the denied user reaches the protected app body.
- [x] P1: Preserve browser timeout diagnostics, including current step, URL, body snippet, and screenshot/trace.
- [x] P1: Make `terrariumctl proxy sync` fail non-zero on route-auth/client/compose errors and verify route-auth listeners after compose.
- [x] P1: Persist integration cloud resources to a manifest and add idempotent cleanup for app restarts/interrupted runs.
- [x] P2: Delay/guard Traefik sync timer startup until LXD, ZITADEL, and oauth2 prerequisites are ready.
- [x] P2: Replace heuristic LXD snap readiness polling with a deterministic snap/LXD readiness gate.
- [x] P2: Improve artifact collection with route-auth compose/logs/probes and reduce noisy tar/SSH warnings.
- [x] P2: Make ZITADEL Cloud preflight/cleanup fail fast and use the same org-scoped API helper.
- [x] P3: Harden HTTP assertion status parsing for redirect-heavy flows.
- [x] P2: Retry bounded idempotent SSH reads so transient transport failures do not abort a healthy smoke run.
- [x] P2: Retry Hetzner locked volume detach/delete states during cleanup.
- [x] P2: Select ZITADEL account cards with browser-like coordinate clicks when the login flow lands on account selection.
- [x] P3: Use ZITADEL project deletion as the fixture cleanup boundary instead of noisy per-app deletes.
- [x] P1: Give the denied ZITADEL fixture user a non-allowed project role so OAuth completes and route auth performs the denial.
