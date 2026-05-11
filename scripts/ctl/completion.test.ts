import { describe, expect, test } from "bun:test";
import { commandCompletionCandidates, completionScript } from "./completion";

describe("terrariumctl completion", () => {
  test("generates bash completion for terrariumctl and trm", () => {
    const script = completionScript("bash");

    expect(script).toContain("complete -F _terrariumctl_complete terrariumctl");
    expect(script).toContain("complete -F _terrariumctl_complete trm");
    expect(script).toContain("backup) COMPREPLY");
    expect(script).toContain("list export restore");
    expect(script).toContain("update");
    expect(script).toContain("update) COMPREPLY");
    expect(script).toContain("--ref --skip-reconfigure --non-interactive");
    expect(script).toContain("--skip-reconfigure");
    expect(script).toContain("--storage-source");
    expect(script).toContain("local oidc");
  });

  test("completes root command prefixes", () => {
    expect(commandCompletionCandidates("st")).toEqual(["status"]);
    expect(commandCompletionCandidates("re")).toEqual(["reconfigure"]);
    expect(commandCompletionCandidates("")).toContain("install");
  });

  test("generates zsh and fish completion for the installed aliases", () => {
    const zsh = completionScript("zsh");
    const fish = completionScript("fish");

    expect(zsh).toContain("#compdef terrariumctl trm");
    expect(zsh).toContain("update) opts=(--ref --skip-reconfigure --non-interactive)");
    expect(zsh).toContain("compadd local oidc");
    expect(fish).toContain("complete -c terrariumctl");
    expect(fish).toContain("complete -c trm");
    expect(fish).toContain("-l oidc-client");
    expect(fish).toContain("-s p");
  });
});
