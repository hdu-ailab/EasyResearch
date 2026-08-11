import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getInternalPiInvocation } from "./internal-invocation";

describe("getInternalPiInvocation", () => {
  it("points at the bundled pi-bootstrap.mjs private entry", () => {
    const invocation = getInternalPiInvocation();
    expect(invocation.command).not.toBe("");
    expect(basename(invocation.args[0] ?? "")).toBe("pi-bootstrap.mjs");
  });

  it("does not expose the public easyresearch entry", () => {
    const invocation = getInternalPiInvocation();
    expect(basename(invocation.command)).not.toBe("easyresearch");
    expect(basename(invocation.args[0] ?? "")).not.toBe("index.ts");
  });

  it("resolves the private entry relative to the runtime module", () => {
    const invocation = getInternalPiInvocation();
    const entry = join(dirname(invocation.args[0] ?? ""), basename(invocation.args[0] ?? ""));
    expect(existsSync(entry)).toBe(true);
  });
});