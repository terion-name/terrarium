import { describe, expect, test } from "bun:test";
import { rewriteRecoveredBackupMetadata } from "./backup";
import { isRetriableS3ExportError } from "../terrarium-s3-export";

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
