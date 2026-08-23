import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performFirstRunSetup, retireBundledResourcesOnce } from "./first-run";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-first-run-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("performFirstRunSetup", () => {
  it("orders setup, smoke evidence, and venv environment injection", () => {
    const order: string[] = [];
    const result = { venvDir: join(root, "venv"), success: true };

    expect(performFirstRunSetup(root, {
      log: () => {},
      skipSetup: false,
      setup: () => {
        order.push("setup");
        return result;
      },
      writeEvidence: (value) => {
        expect(value).toBe(result);
        order.push("evidence");
      },
      injectVenv: () => order.push("inject"),
    })).toBe(result);

    expect(order).toEqual(["setup", "evidence", "inject"]);
  });

  it("uses an existing materialized bundle without running mutating setup when skipped", () => {
    const setup = vi.fn();
    const useExistingSetup = vi.fn();
    const injectVenv = vi.fn();

    expect(performFirstRunSetup(root, {
      log: () => {},
      skipSetup: true,
      setup,
      useExistingSetup,
      injectVenv,
    })).toBeUndefined();

    expect(setup).not.toHaveBeenCalled();
    expect(useExistingSetup).toHaveBeenCalledWith(root);
    expect(injectVenv).toHaveBeenCalledOnce();
  });

  it("keeps setup successful when smoke evidence cannot be written", () => {
    const messages: string[] = [];

    expect(() => performFirstRunSetup(root, {
      log: (message) => messages.push(message),
      skipSetup: false,
      setup: () => ({ venvDir: join(root, "venv"), success: true }),
      writeEvidence: () => { throw new Error("read-only evidence path"); },
      injectVenv: () => {},
    })).not.toThrow();

    expect(messages).toEqual([
      "First-run setup evidence could not be written: read-only evidence path",
    ]);
  });
});

describe("resource retirement version gate", () => {
  it("retires same-name resources only once per version", () => {
    const retire = vi.fn();

    expect(retireBundledResourcesOnce(root, "1.0.0", retire)).toBe(true);
    expect(retireBundledResourcesOnce(root, "1.0.0", retire)).toBe(false);
    expect(retire).toHaveBeenCalledTimes(1);
    expect(retireBundledResourcesOnce(root, "2.0.0", retire)).toBe(true);
    expect(retire).toHaveBeenCalledTimes(2);
  });
});
