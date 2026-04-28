import { describe, expect, test } from "bun:test";
import { rewriteRecoveredBackupMetadata } from "./backup";

describe("backup restore metadata", () => {
  test("renames restored LXD metadata and removes generated identity", () => {
    const rewritten = rewriteRecoveredBackupMetadata(
      {
        container: {
          name: "source",
          config: {
            "security.nesting": "true",
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
            }
          }
        },
        snapshots: [
          {
            name: "source/snap0",
            config: {
              "volatile.eth0.hwaddr": "00:16:3e:53:6a:a5"
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
        config: {}
      }
    ]);
  });
});
