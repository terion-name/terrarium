import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { buildLaunchArgs, launchOptionsFromCli } from "./launch";

const lxc = process.env.TERRARIUM_LXC_BIN ?? "/snap/bin/lxc";

function cloudInitFromArgs(args: string[]): Record<string, unknown> {
  const entry = args.find((arg) => arg.startsWith("cloud-init.user-data="));
  if (!entry) {
    throw new Error("missing cloud-init.user-data launch config");
  }
  return parse(entry.slice("cloud-init.user-data=".length).replace(/^#cloud-config\n/, "")) as Record<string, unknown>;
}

describe("terrariumctl launch", () => {
  test("wraps basic LXD launch resource options", () => {
    expect(buildLaunchArgs("ubuntu:24.04", "web-01", { profiles: ["small"], disk: "40G", memory: "4G", cpu: "2" })).toEqual([
      lxc,
      "launch",
      "ubuntu:24.04",
      "web-01",
      "--profile",
      "small",
      "--device",
      "root,size=40G",
      "--config",
      "limits.memory=4G",
      "--config",
      "limits.cpu=2"
    ]);
  });

  test("validates and writes proxy labels at launch time", () => {
    expect(buildLaunchArgs("ubuntu:24.04", "app", { proxies: ["https://app.example.com:8080@auth:admins"] })).toContain(
      "user.proxy=https://app.example.com:8080@auth:admins"
    );
    expect(() => buildLaunchArgs("ubuntu:24.04", "app", { proxies: ["https://app.example.com:8080@auth:bad!"] })).toThrow(
      "unsupported auth suffix"
    );
  });

  test("builds cloud-init for local requirements, roles, playbooks, and compose files", () => {
    const dir = mkdtempSync(join(tmpdir(), "terrarium-launch-test-"));
    try {
      const requirements = join(dir, "requirements.yml");
      const playbook = join(dir, "site.yml");
      const compose = join(dir, "docker-compose.yml");
      writeFileSync(requirements, "roles:\n  - name: geerlingguy.docker\n");
      writeFileSync(playbook, "- hosts: localhost\n  tasks: []\n");
      writeFileSync(compose, "services:\n  app:\n    image: nginx\n");

      const cloudInit = cloudInitFromArgs(
        buildLaunchArgs("ubuntu:24.04", "docker-01", {
          requirements: [requirements],
          roles: ["geerlingguy.docker"],
          playbooks: [playbook],
          dockerCompose: [compose]
        })
      );

      expect(cloudInit.packages).toEqual(
        expect.arrayContaining(["ansible", "docker.io", "docker-compose-v2"])
      );
      expect(JSON.stringify(cloudInit.write_files)).toContain("geerlingguy.docker");
      expect(JSON.stringify(cloudInit.write_files)).toContain("image: nginx");
      expect(JSON.stringify(cloudInit.runcmd)).toContain("ansible-galaxy role install");
      expect(JSON.stringify(cloudInit.runcmd)).toContain("ansible-playbook -i localhost, -c local");
      expect(JSON.stringify(cloudInit.runcmd)).toContain("docker compose -f");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("maps launch variables into shell, Ansible, and Compose provisioning", () => {
    const dir = mkdtempSync(join(tmpdir(), "terrarium-launch-test-"));
    try {
      const varsFile = join(dir, "vars.env");
      const playbook = join(dir, "site.yml");
      const compose = join(dir, "docker-compose.yml");
      writeFileSync(varsFile, "APP_NAME=from-file\nAPP_PORT=8080\nQUOTED=\"hello world\"\n");
      writeFileSync(playbook, "- hosts: localhost\n  tasks: []\n");
      writeFileSync(compose, "services:\n  app:\n    image: nginx:${APP_VERSION}\n");

      const cloudInit = cloudInitFromArgs(
        buildLaunchArgs("ubuntu:24.04", "app", {
          varsFiles: [varsFile],
          vars: ["APP_NAME=from-cli", "APP_VERSION=1.27"],
          playbooks: [playbook],
          dockerCompose: [compose]
        })
      );

      const renderedFiles = JSON.stringify(cloudInit.write_files);
      const renderedCommands = JSON.stringify(cloudInit.runcmd);
      expect(renderedFiles).toContain("/var/lib/terrarium-launch/vars.env");
      expect(renderedFiles).toContain('APP_NAME=\\"from-cli\\"');
      expect(renderedFiles).toContain('\\"APP_VERSION\\": \\"1.27\\"');
      expect(renderedCommands).toContain(". '/var/lib/terrarium-launch/vars.sh'");
      expect(renderedCommands).toContain("--extra-vars @'/var/lib/terrarium-launch/vars.json'");
      expect(renderedCommands).toContain("docker compose --env-file '/var/lib/terrarium-launch/vars.env'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("builds cloud-init commands for git assets with refs", () => {
    const cloudInit = cloudInitFromArgs(
      buildLaunchArgs("ubuntu:24.04", "app", {
        playbooks: ["git+https://github.com/org/repo.git//site.yml?ref=v1.0.0"],
        dockerCompose: ["git+https://github.com/org/repo.git//compose/docker-compose.yml?ref=v1.0.0"]
      })
    );

    const rendered = JSON.stringify(cloudInit.runcmd);
    expect(rendered).toContain("git clone --depth 1 'https://github.com/org/repo.git'");
    expect(rendered).toContain("checkout 'v1.0.0'");
    expect(rendered).toContain("/var/lib/terrarium-launch/git-1/site.yml");
    expect(rendered).toContain("/var/lib/terrarium-launch/git-2/compose/docker-compose.yml");
  });

  test("passes raw cloud-init and rejects provisioning shortcut combinations", () => {
    const dir = mkdtempSync(join(tmpdir(), "terrarium-launch-test-"));
    try {
      const userData = join(dir, "user-data.yml");
      writeFileSync(userData, "#cloud-config\nhostname: raw-01\n");

      expect(buildLaunchArgs("ubuntu:24.04", "raw-01", { cloudInit: userData })).toContain(
        "cloud-init.user-data=#cloud-config\nhostname: raw-01\n"
      );
      expect(() => buildLaunchArgs("ubuntu:24.04", "raw-01", { cloudInit: userData, playbooks: ["site.yml"] })).toThrow(
        "--cloud-init cannot be combined"
      );
      expect(() => buildLaunchArgs("ubuntu:24.04", "raw-01", { cloudInit: userData, vars: ["FOO=bar"] })).toThrow(
        "--cloud-init cannot be combined"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recovers repeated options from argv when CAC keeps only the last value", () => {
    const originalArgv = process.argv;
    process.argv = [
      "terrariumctl",
      "launch",
      "ubuntu:24.04",
      "app",
      "--playbook",
      "one.yml",
      "--playbook",
      "two.yml",
      "--docker-compose=compose.yml",
      "--var",
      "FOO=bar",
      "--vars=vars.env"
    ];
    try {
      expect(launchOptionsFromCli({ playbook: "two.yml" })).toMatchObject({
        playbooks: ["one.yml", "two.yml"],
        dockerCompose: ["compose.yml"],
        vars: ["FOO=bar"],
        varsFiles: ["vars.env"]
      });
    } finally {
      process.argv = originalArgv;
    }
  });
});
