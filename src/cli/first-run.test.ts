import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performFirstRunSetup, retireBundledResourcesOnce } from "./first-run";
import { renameSameNameToBak } from "../setup-resources";

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
    const retire = vi.fn(() => ({ entries: [] }));

    expect(retireBundledResourcesOnce(root, "1.0.0", retire)).toBe(true);
    expect(retireBundledResourcesOnce(root, "1.0.0", retire)).toBe(false);
    expect(retire).toHaveBeenCalledTimes(1);
    expect(retireBundledResourcesOnce(root, "2.0.0", retire)).toBe(true);
    expect(retire).toHaveBeenCalledTimes(2);
  });

  it("keeps a partially failed retirement retryable without repeating successful renames", () => {
    const agents = join(root, "agents");
    const bundledAgents = join(root, "bundled", "agents");
    const bundledSkills = join(root, "bundled", "skills");
    for (const path of [agents, bundledAgents, bundledSkills]) mkdirSync(path, { recursive: true });
    for (const name of ["writing", "search"]) {
      writeFileSync(join(bundledAgents, `${name}.md`), "bundled");
      writeFileSync(join(agents, `${name}.md`), `user ${name}`);
    }
    const obstruction = join(agents, "writing.md.bak");
    mkdirSync(obstruction);
    writeFileSync(join(obstruction, "keep.txt"), "do not destroy");
    const marker = join(root, ".easyresearch-resource-retirement-version");
    writeFileSync(marker, "previous-version");
    const retire = () => renameSameNameToBak({
      agentDir: root, bundledAgentsDir: bundledAgents, bundledSkillsDir: bundledSkills, log: () => {},
    });

    expect(() => retireBundledResourcesOnce(root, "next-version", retire)).toThrow(/retirement/i);
    expect(readFileSync(marker, "utf8")).toBe("previous-version");
    expect(readFileSync(join(obstruction, "keep.txt"), "utf8")).toBe("do not destroy");
    expect(readFileSync(join(agents, "search.md.bak"), "utf8")).toBe("user search");
    rmSync(obstruction, { recursive: true });

    expect(retireBundledResourcesOnce(root, "next-version", retire)).toBe(true);
    expect(existsSync(join(agents, "writing.md"))).toBe(false);
    expect(readFileSync(join(agents, "writing.md.bak"), "utf8")).toBe("user writing");
    expect(readFileSync(join(agents, "search.md.bak"), "utf8")).toBe("user search");
    expect(readFileSync(marker, "utf8")).toBe("next-version");
    writeFileSync(join(agents, "writing.md"), "edited after successful setup");
    expect(retireBundledResourcesOnce(root, "next-version", retire)).toBe(false);
    expect(readFileSync(join(agents, "writing.md"), "utf8")).toBe("edited after successful setup");
  });

  it("retries only unfinished resources after new user edits and previously absent entries appear", () => {
    const bundledAgents = join(root, "bundled", "agents");
    const bundledSkills = join(root, "bundled", "skills");
    const agents = join(root, "agents");
    const skills = join(root, "skills");
    for (const directory of [bundledAgents, bundledSkills, agents, skills]) mkdirSync(directory, { recursive: true });
    for (const name of ["search", "writing", "new-agent"]) writeFileSync(join(bundledAgents, `${name}.md`), "bundled");
    for (const name of ["shared", "new-skill"]) mkdirSync(join(bundledSkills, name));
    writeFileSync(join(agents, "search.md"), "original search");
    writeFileSync(join(agents, "writing.md"), "original writing");
    mkdirSync(join(skills, "shared"));
    writeFileSync(join(skills, "shared", "SKILL.md"), "original skill");
    const obstruction = join(agents, "writing.md.bak");
    mkdirSync(obstruction);
    const retire = () => renameSameNameToBak({
      agentDir: root, bundledAgentsDir: bundledAgents, bundledSkillsDir: bundledSkills,
      version: "next-version", log: () => {},
    });

    expect(() => retireBundledResourcesOnce(root, "next-version", retire)).toThrow(/retirement/i);
    writeFileSync(join(agents, "search.md"), "new search edit");
    writeFileSync(join(agents, "new-agent.md"), "new agent");
    for (const name of ["shared", "new-skill"]) {
      mkdirSync(join(skills, name));
      writeFileSync(join(skills, name, "SKILL.md"), `new ${name}`);
    }
    rmSync(obstruction, { recursive: true });
    expect(retireBundledResourcesOnce(root, "next-version", retire)).toBe(true);

    expect(readFileSync(join(agents, "search.md.bak"), "utf8")).toBe("original search");
    expect(readFileSync(join(agents, "search.md"), "utf8")).toBe("new search edit");
    expect(readFileSync(join(agents, "writing.md.bak"), "utf8")).toBe("original writing");
    expect(readFileSync(join(agents, "new-agent.md"), "utf8")).toBe("new agent");
    expect(existsSync(join(agents, "new-agent.md.bak"))).toBe(false);
    expect(readFileSync(join(skills, "shared.bak", "SKILL.md"), "utf8")).toBe("original skill");
    expect(readFileSync(join(skills, "shared", "SKILL.md"), "utf8")).toBe("new shared");
    expect(readFileSync(join(skills, "new-skill", "SKILL.md"), "utf8")).toBe("new new-skill");
    expect(existsSync(join(skills, "new-skill.bak"))).toBe(false);
  });

  it("honors an existing shipped plain-text version marker without new bookkeeping or retirement", () => {
    writeFileSync(join(root, ".easyresearch-resource-retirement-version"), "shipped-version");
    const retire = vi.fn(() => ({ entries: [] }));
    expect(retireBundledResourcesOnce(root, "shipped-version", retire)).toBe(false);
    expect(retire).not.toHaveBeenCalled();
    expect(existsSync(join(root, ".easyresearch-resource-retirement-progress"))).toBe(false);
  });

  it("does not guess completion for an interrupted retirement without a usable file identity", () => {
    const agents = join(root, "agents");
    const bundledAgents = join(root, "bundled", "agents");
    const bundledSkills = join(root, "bundled", "skills");
    for (const path of [agents, bundledAgents, bundledSkills]) mkdirSync(path, { recursive: true });
    writeFileSync(join(bundledAgents, "search.md"), "bundled");
    writeFileSync(join(agents, "search.md"), "current user edit");
    writeFileSync(join(agents, "search.md.bak"), "protected backup");
    writeFileSync(join(root, ".easyresearch-resource-retirement-progress"), JSON.stringify({
      version: "next-version", completed: [], pending: { key: "agents/search.md", dev: "0", ino: "0" },
    }));
    expect(() => renameSameNameToBak({
      agentDir: root, bundledAgentsDir: bundledAgents, bundledSkillsDir: bundledSkills, version: "next-version", log: () => {},
    })).toThrow(/identity/i);
    expect(readFileSync(join(agents, "search.md"), "utf8")).toBe("current user edit");
    expect(readFileSync(join(agents, "search.md.bak"), "utf8")).toBe("protected backup");
  });

  it("leaves new user files unchanged when an interrupted retirement's original identity is no longer at either path", () => {
    const agents = join(root, "agents");
    const bundledAgents = join(root, "bundled", "agents");
    const bundledSkills = join(root, "bundled", "skills");
    for (const path of [agents, bundledAgents, bundledSkills]) mkdirSync(path, { recursive: true });
    writeFileSync(join(bundledAgents, "search.md"), "bundled");
    const source = join(agents, "search.md");
    writeFileSync(source, "original search");
    const stat = lstatSync(source, { bigint: true });
    writeFileSync(join(root, ".easyresearch-resource-retirement-progress"), JSON.stringify({
      version: "next-version", completed: [], pending: { key: "agents/search.md", dev: String(stat.dev), ino: String(stat.ino) },
    }));
    renameSync(source, `${source}.original`);
    writeFileSync(source, "new search edit");
    writeFileSync(`${source}.bak`, "another user backup");
    expect(() => renameSameNameToBak({
      agentDir: root, bundledAgentsDir: bundledAgents, bundledSkillsDir: bundledSkills, version: "next-version", log: () => {},
    })).toThrow(/identity/i);
    expect(readFileSync(source, "utf8")).toBe("new search edit");
    expect(readFileSync(`${source}.bak`, "utf8")).toBe("another user backup");
    expect(readFileSync(`${source}.original`, "utf8")).toBe("original search");
  });

  it("recovers a completed rename when its completion write was interrupted", async () => {
    const agents = join(root, "agents");
    const bundledAgents = join(root, "bundled", "agents");
    const bundledSkills = join(root, "bundled", "skills");
    for (const path of [agents, bundledAgents, bundledSkills]) mkdirSync(path, { recursive: true });
    writeFileSync(join(bundledAgents, "search.md"), "bundled");
    const source = join(agents, "search.md");
    writeFileSync(source, "original search");
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let interrupted = true;
    vi.doMock("node:fs", () => ({
      ...fs,
      writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
        if (interrupted && String(args[0]).includes("resource-retirement-progress") && !existsSync(source)) {
          throw new Error("completion write interrupted");
        }
        return fs.writeFileSync(...args);
      },
    }));
    vi.resetModules();
    try {
      const options = { agentDir: root, bundledAgentsDir: bundledAgents, bundledSkillsDir: bundledSkills, version: "next-version", log: () => {} };
      const first = await import("../setup-resources");
      expect(() => first.renameSameNameToBak(options)).toThrow("completion write interrupted");
      writeFileSync(source, "new search edit");
      interrupted = false;
      vi.resetModules();
      const second = await import("../setup-resources");
      second.renameSameNameToBak(options);
      expect(readFileSync(`${source}.bak`, "utf8")).toBe("original search");
      expect(readFileSync(source, "utf8")).toBe("new search edit");
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it.each(["write", "publish"])("reconciles a later pending rename before retrying an earlier failure (%s interruption)", async (failure) => {
    const agents = join(root, "agents");
    const bundledAgents = join(root, "bundled", "agents");
    const bundledSkills = join(root, "bundled", "skills");
    for (const path of [agents, bundledAgents, bundledSkills]) mkdirSync(path, { recursive: true });
    for (const name of ["search", "writing", "z-later"]) {
      writeFileSync(join(bundledAgents, `${name}.md`), "bundled");
      writeFileSync(join(agents, `${name}.md`), `original ${name}`);
    }
    const search = join(agents, "search.md");
    const writing = join(agents, "writing.md");
    const obstruction = `${search}.bak`;
    mkdirSync(obstruction);
    const progressPath = join(root, ".easyresearch-resource-retirement-progress");
    const markerPath = join(root, ".easyresearch-resource-retirement-version");
    writeFileSync(markerPath, "previous-version");
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let interrupted = true;
    const rejectsCompletion = (text: string) => interrupted && JSON.parse(text).completed.includes("agents/writing.md");
    vi.doMock("node:fs", () => ({
      ...fs,
      writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
        if (failure === "write" && String(args[0]).startsWith(`${progressPath}.tmp-`) && rejectsCompletion(String(args[1]))) {
          throw new Error("writing completion interrupted");
        }
        return fs.writeFileSync(...args);
      },
      renameSync: (...args: Parameters<typeof fs.renameSync>) => {
        if (failure === "publish" && String(args[1]) === progressPath && rejectsCompletion(fs.readFileSync(args[0], "utf8"))) {
          throw new Error("writing completion interrupted");
        }
        return fs.renameSync(...args);
      },
    }));
    vi.resetModules();
    try {
      const { retireBundledResourcesOnce } = await import("./first-run");
      const { renameSameNameToBak } = await import("../setup-resources");
      const attempt = () => retireBundledResourcesOnce(root, "next-version", () => renameSameNameToBak({
        agentDir: root, bundledAgentsDir: bundledAgents, bundledSkillsDir: bundledSkills, version: "next-version", log: () => {},
      }));
      expect(attempt).toThrow("writing completion interrupted");
      const pending = readFileSync(progressPath, "utf8");
      expect(JSON.parse(pending).pending.key).toBe("agents/writing.md");
      expect(readFileSync(join(agents, "z-later.md"), "utf8")).toBe("original z-later");
      writeFileSync(writing, "new writing edit");
      rmSync(obstruction, { recursive: true });

      expect(attempt).toThrow("writing completion interrupted");
      expect(readFileSync(`${writing}.bak`, "utf8")).toBe("original writing");
      expect(readFileSync(writing, "utf8")).toBe("new writing edit");
      expect(readFileSync(search, "utf8")).toBe("original search");
      expect(readFileSync(join(agents, "z-later.md"), "utf8")).toBe("original z-later");
      expect(readFileSync(progressPath, "utf8")).toBe(pending);
      expect(readFileSync(markerPath, "utf8")).toBe("previous-version");

      interrupted = false;
      expect(attempt()).toBe(true);
      expect(readFileSync(`${writing}.bak`, "utf8")).toBe("original writing");
      expect(readFileSync(writing, "utf8")).toBe("new writing edit");
      expect(readFileSync(`${search}.bak`, "utf8")).toBe("original search");
      expect(readFileSync(join(agents, "z-later.md.bak"), "utf8")).toBe("original z-later");
      expect(readFileSync(markerPath, "utf8")).toBe("next-version");
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it.each(["intent", "absent", "failed rename"])("stops before the next resource when the %s progress write fails", async (phase) => {
    const agents = join(root, "agents");
    const bundledAgents = join(root, "bundled", "agents");
    const bundledSkills = join(root, "bundled", "skills");
    for (const path of [agents, bundledAgents, bundledSkills]) mkdirSync(path, { recursive: true });
    for (const name of ["search", "writing"]) writeFileSync(join(bundledAgents, `${name}.md`), "bundled");
    if (phase !== "absent") writeFileSync(join(agents, "search.md"), "original search");
    writeFileSync(join(agents, "writing.md"), "untouched writing");
    if (phase === "failed rename") mkdirSync(join(agents, "search.md.bak"));
    let renameFailed = false;
    let rejectedPending: string | undefined;
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({
      ...fs,
      writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
        if (String(args[0]).includes("resource-retirement-progress") && (phase !== "failed rename" || renameFailed)) {
          rejectedPending = JSON.parse(String(args[1])).pending?.key;
          throw new Error("progress persistence failed");
        }
        return fs.writeFileSync(...args);
      },
    }));
    vi.resetModules();
    try {
      const { retireBundledResourcesOnce } = await import("./first-run");
      const { renameSameNameToBak } = await import("../setup-resources");
      expect(() => retireBundledResourcesOnce(root, "next-version", () => renameSameNameToBak({
        agentDir: root, bundledAgentsDir: bundledAgents, bundledSkillsDir: bundledSkills, version: "next-version",
        log: () => { renameFailed = true; },
      }))).toThrow("progress persistence failed");
      expect(readFileSync(join(agents, "writing.md"), "utf8")).toBe("untouched writing");
      expect(existsSync(join(agents, "writing.md.bak"))).toBe(false);
      expect(existsSync(join(root, ".easyresearch-resource-retirement-version"))).toBe(false);
      if (phase === "failed rename") expect(rejectedPending).toBeUndefined();
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it.each(["agents", "skills"])("does not mark retirement complete when the bundled %s directory cannot be enumerated", (kind) => {
    const bundled = join(root, "bundled");
    mkdirSync(bundled);
    const blocked = join(bundled, kind);
    writeFileSync(blocked, "obstruction");
    mkdirSync(join(bundled, kind === "agents" ? "skills" : "agents"));
    const retire = () => renameSameNameToBak({
      agentDir: root, bundledAgentsDir: join(bundled, "agents"), bundledSkillsDir: join(bundled, "skills"), log: () => {},
    });
    expect(() => retireBundledResourcesOnce(root, "next-version", retire)).toThrow();
    expect(existsSync(join(root, ".easyresearch-resource-retirement-version"))).toBe(false);
    rmSync(blocked);
    mkdirSync(blocked);
    expect(retireBundledResourcesOnce(root, "next-version", retire)).toBe(true);
  });
});
