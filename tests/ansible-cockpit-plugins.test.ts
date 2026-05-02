import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("Cockpit plugin fallback builds", () => {
  test("pin upstream bootstrap scripts to their declared Yarn releases", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/cockpit_plugins/tasks/main.yml"), "utf8");

    expect(tasks).toContain("Pin cockpit-zfs source bootstrap to the declared Yarn release");
    expect(tasks).toContain("Pin cockpit-S3ObjectBroswer source bootstrap to the declared Yarn release");
    expect(tasks).toContain("(.packageManager // \"yarn@4.6.0\")");
    expect(tasks).toContain("(.packageManager // \"yarn@4.12.0\")");
    expect(tasks).toContain("sed -i \"s/yarn set version stable/yarn set version ${yarn_version}/\" bootstrap.sh");
  });

  test("installs prebuilt bundles only after pinned integrity and archive validation", () => {
    const defaults = readFileSync(join(repoRoot, "ansible/roles/cockpit_plugins/defaults/main.yml"), "utf8");
    const tasks = readFileSync(join(repoRoot, "ansible/roles/cockpit_plugins/tasks/main.yml"), "utf8");

    expect(defaults).toContain("terrarium_cockpit_plugin_download_dir: /var/lib/terrarium/downloads/cockpit-plugins");
    expect(defaults).toContain("terrarium_cockpit_plugin_stage_dir: /var/lib/terrarium/staging/cockpit-plugins");
    expect(defaults).toContain("terrarium_cockpit_zfs_commit:");
    expect(defaults).toContain("terrarium_cockpit_s3_commit:");
    expect(defaults).toContain("terrarium_cockpit_zfs_bundle_sha256:");
    expect(defaults).toContain("terrarium_cockpit_s3_bundle_sha256:");

    expect(tasks).toContain("Create private Cockpit plugin bundle work directories");
    expect(tasks).toContain('mode: "0700"');
    expect(tasks).toContain("checksum: \"sha256:{{ terrarium_cockpit_zfs_bundle_checksum }}\"");
    expect(tasks).toContain("checksum: \"sha256:{{ terrarium_cockpit_s3_bundle_checksum }}\"");
    expect(tasks).toContain("Validate prebuilt cockpit-zfs bundle metadata");
    expect(tasks).toContain("Validate prebuilt cockpit-s3 bundle metadata");
    expect(tasks).toContain("tar -tvzf \"$archive\" | awk '$1 ~ /^[hlbcps]/");
    expect(tasks).toContain("rsync -a --delete --chown=root:root");
    expect(tasks).toContain("git rev-parse HEAD");
    expect(tasks).not.toContain("dest: /tmp");
    expect(tasks).not.toContain("ansible.builtin.unarchive");
  });
});
