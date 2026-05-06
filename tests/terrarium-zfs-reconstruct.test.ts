import { describe, expect, test } from "bun:test";
import { isRetriableS3RestoreError, isRetriableZfsDestroyError } from "../scripts/terrarium-zfs-reconstruct";

describe("terrarium zfs reconstruct", () => {
  test("treats broken S3 restore streams as retryable", () => {
    expect(
      isRetriableS3RestoreError(
        "download failed: Connection broken: IncompleteRead(4177920 bytes read, 4210688 more expected)\nRead error (39) : premature end\ncannot receive new filesystem stream: incomplete stream"
      )
    ).toBe(true);
  });

  test("does not retry permanent S3 authorization failures", () => {
    expect(isRetriableS3RestoreError("An error occurred (AccessDenied) when calling the GetObject operation")).toBe(false);
  });

  test("treats a busy ZFS dataset destroy as retryable", () => {
    expect(isRetriableZfsDestroyError("cannot destroy snapshot terrarium/containers/app@snap: dataset is busy")).toBe(true);
  });

  test("does not retry permanent ZFS destroy dependency failures", () => {
    expect(isRetriableZfsDestroyError("cannot destroy snapshot terrarium/containers/app@snap: filesystem has dependent clones")).toBe(false);
  });
});
