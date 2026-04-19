import {
  adminGroup,
  defaultServiceDomain,
  heading,
  idpEnabled,
  idpMode,
  label,
  localIdpEnabled,
  oidcIssuer,
  requireConfig,
  value
} from "./context";
import { configString, runAllowFailure } from "../lib/common";

/**
 * Prints a concise operational snapshot of the local Terrarium installation.
 *
 * The status view is intentionally human-oriented: it shows endpoints, auth
 * mode, and the key services users actually care about when checking whether a
 * host is healthy.
 */
export async function statusCmd(): Promise<void> {
  const config = requireConfig();
  const pool = configString(config, "terrarium_lxd_pool_name", "terrarium");
  const publicIp = configString(config, "terrarium_public_ip");
  const rootDomain = configString(config, "terrarium_root_domain");
  const manage = configString(config, "terrarium_manage_domain", defaultServiceDomain(rootDomain, publicIp, "manage"));
  const proxy = configString(config, "terrarium_proxy_domain", defaultServiceDomain(rootDomain, publicIp, "proxy"));
  const lxd = configString(config, "terrarium_lxd_domain", defaultServiceDomain(rootDomain, publicIp, "lxd"));
  const auth = configString(config, "terrarium_auth_domain");
  const oidc = oidcIssuer(config);
  const mode = idpMode(config);
  const idp = idpEnabled(config);
  const adminRole = adminGroup(config);

  const traefik = await runAllowFailure(["systemctl", "is-active", "traefik"]);
  const cockpit = await runAllowFailure(["systemctl", "is-active", "cockpit.socket"]);
  const lxdState = await runAllowFailure(["systemctl", "is-active", "snap.lxd.daemon"]);
  const zitadel = localIdpEnabled(config) ? await runAllowFailure(["systemctl", "is-active", "terrarium-zitadel.service"]) : null;
  const oauth2Proxy = idp ? await runAllowFailure(["systemctl", "is-active", "terrarium-oauth2-proxy.service"]) : null;
  const s3Timer = await runAllowFailure(["systemctl", "is-active", "terrarium-s3-backup.timer"]);
  const syncoidTimer = await runAllowFailure(["systemctl", "is-active", "terrarium-syncoid.timer"]);
  const traefikSyncTimer = await runAllowFailure(["systemctl", "is-active", "terrarium-traefik-sync.timer"]);

  console.log(heading("Terrarium status"));
  console.log(`  ${label("Config:")} ${value("/etc/terrarium/config.yaml")}`);
  console.log(`  ${label("Pool:")} ${value(pool)}`);
  console.log(`  ${label("Cockpit:")} ${value(`https://${manage}`)}`);
  console.log(`  ${label("Traefik dashboard:")} ${value(`https://${proxy}`)}`);
  console.log(`  ${label("LXD:")} ${value(`https://${lxd}`)}`);
  console.log(`  ${label("IDP mode:")} ${value(mode)}`);
  if (oidc) {
    console.log(`  ${label("OIDC issuer:")} ${value(oidc)}`);
  }
  if (adminRole) {
    console.log(`  ${label("Admin group:")} ${value(adminRole)}`);
  }
  if (localIdpEnabled(config)) {
    console.log(`  ${label("ZITADEL:")} ${value(`https://${auth}`)}`);
    console.log(`  ${label("ZITADEL bootstrap password:")} ${value("/etc/terrarium/secrets/zitadel_admin_password")}`);
  }
  console.log(`  ${label("traefik:")} ${value(traefik.stdout.trim())}`);
  console.log(`  ${label("cockpit.socket:")} ${value(cockpit.stdout.trim())}`);
  console.log(`  ${label("lxd:")} ${value(lxdState.stdout.trim())}`);
  if (oauth2Proxy) {
    console.log(`  ${label("terrarium-oauth2-proxy.service:")} ${value(oauth2Proxy.stdout.trim())}`);
  }
  if (zitadel) {
    console.log(`  ${label("terrarium-zitadel.service:")} ${value(zitadel.stdout.trim())}`);
  }
  console.log(`  ${label("terrarium-s3-backup.timer:")} ${value(s3Timer.stdout.trim())}`);
  console.log(`  ${label("terrarium-syncoid.timer:")} ${value(syncoidTimer.stdout.trim())}`);
  console.log(`  ${label("terrarium-traefik-sync.timer:")} ${value(traefikSyncTimer.stdout.trim())}`);
}
