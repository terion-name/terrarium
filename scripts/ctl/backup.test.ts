import { describe, expect, test } from "bun:test";
import { assertNewRestoreTargetIsUnused, rewriteRecoveredBackupMetadata } from "./backup";
import { chooseLatestExportSnapshot, isRetriableS3ExportError } from "../terrarium-s3-export";

describe("backup restore metadata", () => {
  test("classifies transient S3 export errors for retry", () => {
    expect(
      isRetriableS3ExportError(
        "upload failed: - to s3://bucket/key An error occurred (GatewayTimeout) when calling the UploadPart operation"
      )
    ).toBe(true);
    expect(isRetriableS3ExportError("An error occurred (SlowDown) when calling the PutObject operation")).toBe(true);
    expect(isRetriableS3ExportError("An error occurred (InvalidAccessKeyId) when calling the PutObject operation")).toBe(false);
  });

  test("does not export short-lived frequent snapshots as backup chain parents", () => {
    expect(
      chooseLatestExportSnapshot(
        [
          "terrarium/containers/app@autosnap_2026-05-02_12:00:00_hourly",
          "terrarium/containers/app@autosnap_2026-05-02_12:15:00_frequently",
          "terrarium/containers/app@manual-keep",
          "terrarium/containers/other@autosnap_2026-05-02_12:30:00_hourly"
        ],
        "terrarium/containers/app"
      )
    ).toBe("terrarium/containers/app@manual-keep");
  });

  test("renames restored LXD metadata and removes generated identity", () => {
    const rewritten = rewriteRecoveredBackupMetadata(
      {
        container: {
          name: "source",
          config: {
            "security.nesting": "true",
            "user.proxy": "https://source.example.com:8080",
            "volatile.eth0.hwaddr": "00:16:3e:53:6a:a5",
            "volatile.uuid": "original-uuid"
          },
          devices: {
            eth0: {
              type: "nic",
              name: "eth0",
              network: "lxdbr0",
              hwaddr: "00:16:3e:53:6a:a5"
            },
            root: {
              type: "disk",
              path: "/",
              pool: "terrarium"
            },
            "terrarium-proxy-http-8080-abcd1234": {
              type: "proxy",
              listen: "tcp:127.0.0.1:18081",
              connect: "tcp:127.0.0.1:8080"
            },
            "manual-host-proxy": {
              type: "proxy",
              listen: "tcp:0.0.0.0:9443",
              connect: "tcp:127.0.0.1:443"
            }
          }
        },
        snapshots: [
          {
            name: "source/snap0",
            config: {
              "user.proxy": "https://source.example.com:8080",
              "volatile.eth0.hwaddr": "00:16:3e:53:6a:a5"
            },
            devices: {
              "terrarium-proxy-http-8080-abcd1234": {
                type: "proxy",
                listen: "tcp:127.0.0.1:18081",
                connect: "tcp:127.0.0.1:8080"
              }
            }
          }
        ]
      },
      "source",
      "restored"
    );

    expect(rewritten.container).toEqual({
      name: "restored",
      config: {
        "security.nesting": "true"
      },
      devices: {
        eth0: {
          type: "nic",
          name: "eth0",
          network: "lxdbr0"
        },
        root: {
          type: "disk",
          path: "/",
          pool: "terrarium"
        }
      }
    });
    expect(rewritten.snapshots).toEqual([
      {
        name: "restored/snap0",
        config: {},
        devices: {}
      }
    ]);
  });
});

describe("backup restore target safety", () => {
  test("rejects restore-as-new when the target LXD instance already exists", async () => {
    await expect(
      assertNewRestoreTargetIsUnused("victim", "terrarium/containers/victim", async (cmd) => {
        if (cmd.join(" ") === "lxc info victim") {
          return { exitCode: 0, stdout: "Name: victim\n", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "not found" };
      })
    ).rejects.toThrow("target instance 'victim' already exists");
  });

  test("rejects restore-as-new when the target ZFS dataset already exists", async () => {
    const commands: string[] = [];

    await expect(
      assertNewRestoreTargetIsUnused("victim", "terrarium/containers/victim", async (cmd) => {
        commands.push(cmd.join(" "));
        if (cmd.join(" ") === "zfs list -H terrarium/containers/victim") {
          return { exitCode: 0, stdout: "terrarium/containers/victim\n", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "not found" };
      })
    ).rejects.toThrow("target dataset 'terrarium/containers/victim' already exists");

    expect(commands).toEqual(["lxc info victim", "zfs list -H terrarium/containers/victim"]);
  });
});
