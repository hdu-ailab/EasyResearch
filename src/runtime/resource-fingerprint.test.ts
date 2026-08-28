import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as resourceFingerprint from "./resource-fingerprint";

const { fingerprintGlobalSkillResources, fingerprintSkillRoot } = resourceFingerprint;

const EXPECTED_MAX_DEPTH = 16;
const EXPECTED_MAX_DESCRIPTORS = 4096;
const EXPECTED_MAX_DESCRIPTOR_BYTES = 1_048_576;
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-resource-fingerprint-"));
  tempRoots.push(root);
  return root;
}

function nestedDirectory(root: string, depth: number): string {
  return join(root, ...Array.from({ length: depth }, (_, index) => `level-${String(index + 1).padStart(2, "0")}`));
}

function createDeepDescriptor(root: string, depth: number, symlinkDescriptor: boolean): string {
  const directory = nestedDirectory(root, depth);
  mkdirSync(directory, { recursive: true });
  const descriptor = join(directory, "SKILL.md");
  if (!symlinkDescriptor) {
    writeFileSync(descriptor, `depth ${depth}`, "utf8");
    return descriptor;
  }

  const targets = join(root, "z-targets");
  mkdirSync(targets, { recursive: true });
  const target = join(targets, `depth-${depth}.txt`);
  writeFileSync(target, `depth ${depth}`, "utf8");
  symlinkSync(relative(directory, target), descriptor, "file");
  return descriptor;
}

describe("Skill descriptor relative-path classification", () => {
  it.each([
    "alpha.md",
    "SKILL.md",
    "nested/SKILL.md",
    "nested\\SKILL.md",
    "namespace/deep/SKILL.md",
    "namespace\\deep/SKILL.md",
  ])("accepts the descriptor path %j", (relativePath) => {
    expect(resourceFingerprint.isSkillDescriptorRelativePath(relativePath)).toBe(true);
  });

  it.each([
    "",
    ".md",
    "/alpha.md",
    "\\alpha.md",
    "C:\\alpha.md",
    "C:/alpha.md",
    "C:alpha.md",
    "alpha\0.md",
    ".",
    "./alpha.md",
    ".\\alpha.md",
    "../alpha.md",
    "..\\alpha.md",
    "nested/./SKILL.md",
    "nested\\..\\SKILL.md",
    "nested//SKILL.md",
    "nested\\\\SKILL.md",
    "nested/\\SKILL.md",
    "nested/SKILL.md/",
    "nested\\SKILL.md\\",
    "nested/README.md",
    "nested\\README.md",
    "nested",
    "nested/",
    "nested\\",
  ])("rejects the non-descriptor path %j", (relativePath) => {
    expect(resourceFingerprint.isSkillDescriptorRelativePath(relativePath)).toBe(false);
  });
});

describe("canonical synchronous Skill descriptor enumeration", () => {
  it("returns bytewise descriptor metadata used for first-name-wins collisions", () => {
    const root = join(tempRoot(), "skills");
    mkdirSync(join(root, "foo"), { recursive: true });
    mkdirSync(join(root, "namespace", "deep"), { recursive: true });
    writeFileSync(join(root, "foo.md"), "root file", "utf8");
    writeFileSync(join(root, "foo", "SKILL.md"), "directory collision", "utf8");
    writeFileSync(join(root, "namespace", "deep", "SKILL.md"), "nested", "utf8");

    expect(resourceFingerprint.enumerateSkillDescriptors(root)).toEqual([
      {
        name: "foo",
        relativePath: "foo.md",
        path: join(root, "foo.md"),
        skillPath: join(root, "foo.md"),
        canonicalPath: join(root, "foo.md"),
        canonicalSkillPath: join(root, "foo.md"),
      },
      {
        name: "foo",
        relativePath: "foo/SKILL.md",
        path: join(root, "foo"),
        skillPath: join(root, "foo", "SKILL.md"),
        canonicalPath: join(root, "foo"),
        canonicalSkillPath: join(root, "foo", "SKILL.md"),
      },
      {
        name: "deep",
        relativePath: "namespace/deep/SKILL.md",
        path: join(root, "namespace", "deep"),
        skillPath: join(root, "namespace", "deep", "SKILL.md"),
        canonicalPath: join(root, "namespace", "deep"),
        canonicalSkillPath: join(root, "namespace", "deep", "SKILL.md"),
      },
    ]);
  });

  it("shares containment, cycle, depth, and descriptor-size bounds with fingerprinting", () => {
    const root = join(tempRoot(), "skills");
    const external = tempRoot();
    mkdirSync(join(root, "namespace", "deep"), { recursive: true });
    mkdirSync(join(external, "outside"), { recursive: true });
    writeFileSync(join(root, "namespace", "deep", "SKILL.md"), "inside", "utf8");
    writeFileSync(join(external, "outside", "SKILL.md"), "outside", "utf8");
    symlinkSync("..", join(root, "namespace", "cycle"), "dir");
    symlinkSync(join(external, "outside"), join(root, "outside"), "dir");

    expect(resourceFingerprint.enumerateSkillDescriptors(root)).toEqual([
      {
        name: "deep",
        relativePath: "namespace/deep/SKILL.md",
        path: join(root, "namespace", "deep"),
        skillPath: join(root, "namespace", "deep", "SKILL.md"),
        canonicalPath: join(root, "namespace", "deep"),
        canonicalSkillPath: join(root, "namespace", "deep", "SKILL.md"),
      },
    ]);

    const tooDeep = join(tempRoot(), "skills");
    createDeepDescriptor(tooDeep, EXPECTED_MAX_DEPTH + 1, false);
    expect(() => resourceFingerprint.enumerateSkillDescriptors(tooDeep)).toThrow(/depth/i);

    const tooLarge = join(tempRoot(), "skills");
    mkdirSync(tooLarge);
    writeFileSync(join(tooLarge, "large.md"), Buffer.alloc(EXPECTED_MAX_DESCRIPTOR_BYTES + 1, 0x61));
    expect(() => resourceFingerprint.enumerateSkillDescriptors(tooLarge)).toThrow(/bytes|size/i);
  });

  it("preserves logical alias identity while exposing canonical contained copy paths", () => {
    const root = join(tempRoot(), "skills");
    const canonical = join(root, "z-real-skill");
    const alias = join(root, "alias-skill");
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "SKILL.md"), "aliased", "utf8");
    symlinkSync("z-real-skill", alias, "dir");

    expect(resourceFingerprint.enumerateSkillDescriptors(root)).toEqual([{
      name: "alias-skill",
      relativePath: "alias-skill/SKILL.md",
      path: alias,
      skillPath: join(alias, "SKILL.md"),
      canonicalPath: canonical,
      canonicalSkillPath: join(canonical, "SKILL.md"),
    }]);
  });

  it("separates a logical Skill directory from its symlinked descriptor target", () => {
    const root = join(tempRoot(), "skills");
    const logical = join(root, "logical-skill");
    const descriptorTargetDirectory = join(root, "descriptor-target");
    const descriptorTarget = join(descriptorTargetDirectory, "source-descriptor.md");
    mkdirSync(logical, { recursive: true });
    mkdirSync(descriptorTargetDirectory, { recursive: true });
    writeFileSync(descriptorTarget, "target descriptor", "utf8");
    writeFileSync(join(descriptorTargetDirectory, "unrelated.bin"), Buffer.from([9, 8, 7]));
    writeFileSync(join(logical, "asset.bin"), Buffer.from([1, 2, 3]));
    symlinkSync("../descriptor-target/source-descriptor.md", join(logical, "SKILL.md"), "file");

    expect(resourceFingerprint.enumerateSkillDescriptors(root)).toEqual([{
      name: "logical-skill",
      relativePath: "logical-skill/SKILL.md",
      path: logical,
      skillPath: join(logical, "SKILL.md"),
      canonicalPath: logical,
      canonicalSkillPath: descriptorTarget,
    }]);
  });
});

async function mutateAfterDescriptorOpen(
  descriptor: string,
  mutation: () => void,
): Promise<{ didMutate(): boolean; restore(): void }> {
  const probe = await open(descriptor, "r");
  const prototype = Object.getPrototypeOf(probe) as { stat: typeof probe.stat };
  const originalStat = prototype.stat;
  await probe.close();
  let mutated = false;
  const statSpy = vi.spyOn(prototype, "stat").mockImplementation(async function (
    this: typeof probe,
    ...args: Parameters<typeof originalStat>
  ) {
    const stats = await originalStat.apply(this, args);
    if (!mutated) {
      mutated = true;
      mutation();
    }
    return stats;
  });
  return {
    didMutate: () => mutated,
    restore: () => statSpy.mockRestore(),
  };
}

describe("mutable Skill resource fingerprints", () => {
  it("hashes only descriptors so missing, empty, auxiliary-only, and temp-artifact roots are identical", async () => {
    const root = join(tempRoot(), "missing-skills");

    const missing = await fingerprintSkillRoot(root, "global");
    expect(missing.descriptors).toEqual([]);
    expect(await fingerprintSkillRoot(root, "global")).toEqual(missing);
    expect((await fingerprintSkillRoot(root, "project")).value).not.toBe(missing.value);

    mkdirSync(root);
    const present = await fingerprintSkillRoot(root, "global");
    expect(present.descriptors).toEqual([]);
    expect(present).toEqual(missing);

    mkdirSync(join(root, "empty", "nested"), { recursive: true });
    writeFileSync(join(root, "notes.txt"), "auxiliary", "utf8");
    writeFileSync(join(root, "empty", "nested", ".SKILL.md.failed.tmp"), "temp", "utf8");
    expect(await fingerprintSkillRoot(root, "global")).toEqual(present);

    writeFileSync(join(root, "empty", "nested", "SKILL.md"), "descriptor", "utf8");
    expect((await fingerprintSkillRoot(root, "global")).value).not.toBe(present.value);
  });

  it("hashes only root Markdown files and recursively discovered SKILL.md descriptors", async () => {
    const root = join(tempRoot(), "skills");
    mkdirSync(join(root, "namespace", "deep"), { recursive: true });
    writeFileSync(join(root, "alpha.md"), "alpha", "utf8");
    writeFileSync(join(root, "notes.txt"), "root auxiliary", "utf8");
    writeFileSync(join(root, "namespace", "README.md"), "nested Markdown", "utf8");
    writeFileSync(join(root, "namespace", "deep", "SKILL.md"), "deep skill", "utf8");
    writeFileSync(join(root, "namespace", "deep", "script.ts"), "export {};", "utf8");

    const fingerprint = await fingerprintSkillRoot(root, "global");

    expect(fingerprint.descriptors).toEqual(["alpha.md", "namespace/deep/SKILL.md"]);
  });

  it("uses Pi frontmatter identity for effective descriptors while retaining malformed structural bytes", async () => {
    const root = join(tempRoot(), "skills");
    mkdirSync(join(root, "folder-name"), { recursive: true });
    mkdirSync(join(root, "missing-description"), { recursive: true });
    writeFileSync(
      join(root, "folder-name", "SKILL.md"),
      "---\nname: declared-name\ndescription: Valid\n---\nBody\n",
      "utf8",
    );
    writeFileSync(
      join(root, "missing-description", "SKILL.md"),
      "---\nname: omitted\n---\nBody\n",
      "utf8",
    );

    const fingerprint = await fingerprintSkillRoot(root, "global");

    expect(fingerprint.descriptors).toEqual([
      "folder-name/SKILL.md",
      "missing-description/SKILL.md",
    ]);
    expect(fingerprint.skillDescriptors).toEqual([
      { name: "declared-name", relativePath: "folder-name/SKILL.md" },
    ]);
  });

  it("materializes immutable accepted descriptor bytes while preserving the original base directory", async () => {
    const base = tempRoot();
    const root = join(base, "skills");
    const snapshotRoot = join(base, "snapshots");
    const skillDir = join(root, "stable");
    const descriptor = join(skillDir, "SKILL.md");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(descriptor, "---\nname: stable\ndescription: Stable\n---\nBODY_V1\n", "utf8");

    const fingerprint = await fingerprintSkillRoot(root, "global", snapshotRoot);
    const accepted = fingerprint.skillDescriptors[0];
    expect(accepted).toMatchObject({
      name: "stable",
      relativePath: "stable/SKILL.md",
      baseDir: skillDir,
    });
    expect(accepted?.snapshotPath).not.toBe(descriptor);
    expect(readFileSync(accepted!.snapshotPath!, "utf8")).toContain("BODY_V1");

    writeFileSync(descriptor, "---\nname: stable\ndescription: Stable\n---\nBODY_V2\n", "utf8");
    expect(readFileSync(accepted!.snapshotPath!, "utf8")).toContain("BODY_V1");
    expect(resourceFingerprint.applySkillSnapshotBaseDirs({
      skills: [{ filePath: accepted!.snapshotPath!, baseDir: join(snapshotRoot, "wrong") }],
      diagnostics: [],
    }).skills[0]?.baseDir).toBe(skillDir);
  });

  it("changes for same-size edits, add/unlink, and atomic descriptor replacement", async () => {
    const root = join(tempRoot(), "skills");
    mkdirSync(root);
    writeFileSync(join(root, "alpha.md"), "alpha", "utf8");
    const original = await fingerprintSkillRoot(root, "global");

    writeFileSync(join(root, "alpha.md"), "ALPHA", "utf8");
    const sameSizeEdit = await fingerprintSkillRoot(root, "global");
    expect(sameSizeEdit.value).not.toBe(original.value);

    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "SKILL.md"), "nested", "utf8");
    const added = await fingerprintSkillRoot(root, "global");
    expect(added.value).not.toBe(sameSizeEdit.value);
    unlinkSync(join(root, "nested", "SKILL.md"));
    expect((await fingerprintSkillRoot(root, "global")).value).toBe(sameSizeEdit.value);

    writeFileSync(join(root, "replacement.tmp"), "omega", "utf8");
    renameSync(join(root, "replacement.tmp"), join(root, "alpha.md"));
    expect((await fingerprintSkillRoot(root, "global")).value).not.toBe(sameSizeEdit.value);
  });

  it("does not change for auxiliary files, unrelated nested Markdown, or nested empty directories", async () => {
    const root = join(tempRoot(), "skills");
    mkdirSync(root);
    writeFileSync(join(root, "alpha.md"), "alpha", "utf8");
    const before = await fingerprintSkillRoot(root, "global");

    mkdirSync(join(root, "namespace", "empty"), { recursive: true });
    writeFileSync(join(root, "namespace", "README.md"), "not a descriptor", "utf8");
    writeFileSync(join(root, "namespace", "helper.py"), "print('auxiliary')", "utf8");
    writeFileSync(join(root, "asset.bin"), Buffer.from([0, 1, 2, 3]));

    expect(await fingerprintSkillRoot(root, "global")).toEqual(before);
  });

  it("excludes Pi-ignored auxiliary trees before applying traversal bounds", async () => {
    const root = join(tempRoot(), "skills");
    const visible = join(root, "visible");
    mkdirSync(visible, { recursive: true });
    writeFileSync(join(visible, "SKILL.md"), "visible", "utf8");
    writeFileSync(join(root, ".gitignore"), "ignored-root/\n", "utf8");
    mkdirSync(nestedDirectory(join(root, ".hidden"), EXPECTED_MAX_DEPTH + 1), { recursive: true });
    mkdirSync(nestedDirectory(join(root, "node_modules"), EXPECTED_MAX_DEPTH + 1), { recursive: true });
    mkdirSync(nestedDirectory(join(root, "ignored-root"), EXPECTED_MAX_DEPTH + 1), { recursive: true });

    const namespace = join(root, "namespace");
    mkdirSync(namespace, { recursive: true });
    writeFileSync(join(namespace, ".ignore"), "generated/\n", "utf8");
    mkdirSync(nestedDirectory(join(namespace, "generated"), EXPECTED_MAX_DEPTH + 1), { recursive: true });

    expect((await fingerprintSkillRoot(root, "global")).descriptors).toEqual(["visible/SKILL.md"]);
  });

  it("keeps migration backup directories inert", async () => {
    const root = join(tempRoot(), "skills");
    mkdirSync(join(root, "retired.bak"), { recursive: true });
    mkdirSync(join(root, "active"), { recursive: true });
    writeFileSync(join(root, "retired.bak", "SKILL.md"), "retired", "utf8");
    writeFileSync(join(root, "active", "SKILL.md"), "active", "utf8");

    expect((await fingerprintSkillRoot(root, "global")).descriptors).toEqual(["active/SKILL.md"]);
  });

  it("does not follow an ignore control symlink outside the controlled root", async () => {
    const root = join(tempRoot(), "skills");
    const outside = join(tempRoot(), "outside.ignore");
    mkdirSync(join(root, "visible"), { recursive: true });
    writeFileSync(join(root, "visible", "SKILL.md"), "visible", "utf8");
    writeFileSync(outside, "visible/\n", "utf8");
    symlinkSync(outside, join(root, ".gitignore"), "file");

    expect((await fingerprintSkillRoot(root, "global")).descriptors).toEqual(["visible/SKILL.md"]);
  });

  it("orders normalized descriptor paths bytewise rather than by creation or locale order", async () => {
    const root = join(tempRoot(), "skills");
    mkdirSync(join(root, "z", "deep"), { recursive: true });
    writeFileSync(join(root, "\u{10000}.md"), "astral", "utf8");
    writeFileSync(join(root, "\uE000.md"), "private", "utf8");
    writeFileSync(join(root, "z", "deep", "SKILL.md"), "deep", "utf8");

    expect((await fingerprintSkillRoot(root, "global")).descriptors).toEqual([
      "z/deep/SKILL.md",
      "\uE000.md",
      "\u{10000}.md",
    ]);
  });

  it("fingerprints global Skills and hashes optional-home Skills only when enabled", async () => {
    const base = tempRoot();
    const agentDir = join(base, "agent");
    const homeDir = join(base, "home");
    mkdirSync(join(agentDir, "skills"), { recursive: true });
    mkdirSync(join(homeDir, ".agents", "skills", "group"), { recursive: true });
    writeFileSync(join(agentDir, "skills", "global.md"), "global", "utf8");
    writeFileSync(
      join(homeDir, ".agents", "skills", "home.md"),
      "---\nname: root-ignored\ndescription: ignored\n---\n",
      "utf8",
    );
    writeFileSync(
      join(homeDir, ".agents", "skills", "group", "home.md"),
      "---\nname: home\ndescription: home\n---\n",
      "utf8",
    );

    const disabled = await fingerprintGlobalSkillResources({
      agentDir,
      homeDir,
      enableDotAgentsSkill: false,
    });
    const enabled = await fingerprintGlobalSkillResources({
      agentDir,
      homeDir,
      enableDotAgentsSkill: true,
    });

    expect(disabled.globalSkills.descriptors).toEqual(["global.md"]);
    expect(disabled.homeSkills).toBeNull();
    expect(enabled.globalSkills).toEqual(disabled.globalSkills);
    expect(enabled.homeSkills?.descriptors).toEqual(["group/home.md"]);
    expect(enabled.homeSkills?.skillDescriptors).toEqual([
      { name: "home", relativePath: "group/home.md" },
    ]);
  });
});

describe("bounded Skill descriptor traversal", () => {
  it.each([
    { anchor: "global regular", prefix: ["agent", "skills"], symlinkDescriptor: false },
    { anchor: "global symlink", prefix: ["agent", "skills"], symlinkDescriptor: true },
    { anchor: "optional-home regular", prefix: ["home", ".agents", "skills"], symlinkDescriptor: false },
    { anchor: "optional-home symlink", prefix: ["home", ".agents", "skills"], symlinkDescriptor: true },
    { anchor: "project regular", prefix: ["paper", ".easyresearch", "skills"], symlinkDescriptor: false },
    { anchor: "project symlink", prefix: ["paper", ".easyresearch", "skills"], symlinkDescriptor: true },
  ])("accepts depth 16 and rejects depth 17 from the $anchor anchor", async ({ prefix, symlinkDescriptor }) => {
    const acceptedRoot = join(tempRoot(), ...prefix);
    createDeepDescriptor(acceptedRoot, EXPECTED_MAX_DEPTH, symlinkDescriptor);
    const accepted = await fingerprintSkillRoot(acceptedRoot, "global");
    expect(accepted.descriptors).toEqual([
      `${Array.from({ length: EXPECTED_MAX_DEPTH }, (_, index) => `level-${String(index + 1).padStart(2, "0")}`).join("/")}/SKILL.md`,
    ]);

    const rejectedRoot = join(tempRoot(), ...prefix);
    createDeepDescriptor(rejectedRoot, EXPECTED_MAX_DEPTH + 1, symlinkDescriptor);
    await expect(fingerprintSkillRoot(rejectedRoot, "global")).rejects.toThrow(/depth/i);
  });

  it("rejects a depth-17 alias even when its real directory was already visited shallowly", async () => {
    const root = join(tempRoot(), "skills");
    const shallow = join(root, "a-shallow");
    const deepParent = nestedDirectory(root, EXPECTED_MAX_DEPTH);
    mkdirSync(shallow, { recursive: true });
    mkdirSync(deepParent, { recursive: true });
    writeFileSync(join(shallow, "SKILL.md"), "shallow", "utf8");
    symlinkSync(relative(deepParent, shallow), join(deepParent, "depth-17-alias"), "dir");

    await expect(fingerprintSkillRoot(root, "global")).rejects.toThrow(/depth/i);
  });

  it("accepts exactly 4096 descriptors and rejects the 4097th without a partial fingerprint", async () => {
    const root = join(tempRoot(), "skills");
    mkdirSync(root);
    for (let index = 0; index < EXPECTED_MAX_DESCRIPTORS; index += 1) {
      writeFileSync(join(root, `skill-${String(index).padStart(4, "0")}.md`), "", "utf8");
    }

    const accepted = await fingerprintSkillRoot(root, "global");
    expect(accepted.descriptors).toHaveLength(EXPECTED_MAX_DESCRIPTORS);

    writeFileSync(join(root, "skill-overflow.md"), "", "utf8");
    await expect(fingerprintSkillRoot(root, "global")).rejects.toThrow(/4096|descriptor limit/i);
  }, 30_000);

  it("accepts a 1 MiB descriptor", async () => {
    const root = join(tempRoot(), "skills");
    mkdirSync(root);
    writeFileSync(join(root, "alpha.md"), Buffer.alloc(EXPECTED_MAX_DESCRIPTOR_BYTES, 0x61));

    expect((await fingerprintSkillRoot(root, "global")).descriptors).toEqual(["alpha.md"]);
  });

  it.each([
    { target: "direct descriptor", symlinkTarget: false },
    { target: "in-root symlink target", symlinkTarget: true },
  ])("rejects a 1,048,577-byte $target", async ({ symlinkTarget }) => {
    const root = join(tempRoot(), "skills");
    mkdirSync(root);
    const descriptor = join(root, "alpha.md");
    if (symlinkTarget) {
      writeFileSync(join(root, "payload.bin"), Buffer.alloc(EXPECTED_MAX_DESCRIPTOR_BYTES + 1, 0x61));
      symlinkSync("payload.bin", descriptor, "file");
    } else {
      writeFileSync(descriptor, Buffer.alloc(EXPECTED_MAX_DESCRIPTOR_BYTES + 1, 0x61));
    }

    await expect(fingerprintSkillRoot(root, "global")).rejects.toThrow(/1.?048.?576|bytes|size/i);
  });

  it("rejects a descriptor that grows after its initial file-handle stat", async () => {
    const root = join(tempRoot(), "skills");
    mkdirSync(root);
    const descriptor = join(root, "alpha.md");
    writeFileSync(descriptor, Buffer.alloc(EXPECTED_MAX_DESCRIPTOR_BYTES, 0x61));

    const probe = await open(descriptor, "r");
    const prototype = Object.getPrototypeOf(probe) as { stat: typeof probe.stat };
    const originalStat = prototype.stat;
    await probe.close();
    let grew = false;
    const statSpy = vi.spyOn(prototype, "stat").mockImplementation(async function (
      this: typeof probe,
      ...args: Parameters<typeof originalStat>
    ) {
      const stats = await originalStat.apply(this, args);
      if (!grew) {
        grew = true;
        appendFileSync(descriptor, Buffer.from([0x62]));
      }
      return stats;
    });

    try {
      await expect(fingerprintSkillRoot(root, "global")).rejects.toThrow(/bytes|changed|size/i);
      expect(grew).toBe(true);
    } finally {
      statSpy.mockRestore();
    }
  });
});

describe("Skill descriptor symlink containment", () => {
  it("hashes an in-root symlink descriptor and notices same-size target edits and unlink", async () => {
    const root = join(tempRoot(), "skills");
    mkdirSync(root);
    writeFileSync(join(root, "payload.txt"), "alpha", "utf8");
    const before = await fingerprintSkillRoot(root, "global");

    symlinkSync("payload.txt", join(root, "alpha.md"), "file");
    const linked = await fingerprintSkillRoot(root, "global");
    expect(linked.descriptors).toEqual(["alpha.md"]);
    expect(linked.value).not.toBe(before.value);

    writeFileSync(join(root, "payload.txt"), "ALPHA", "utf8");
    expect((await fingerprintSkillRoot(root, "global")).value).not.toBe(linked.value);

    unlinkSync(join(root, "alpha.md"));
    expect(await fingerprintSkillRoot(root, "global")).toEqual(before);
  });

  it("breaks in-root directory cycles without rejecting or duplicating descriptors", async () => {
    const root = join(tempRoot(), "skills");
    mkdirSync(join(root, "namespace", "deep"), { recursive: true });
    writeFileSync(join(root, "namespace", "deep", "SKILL.md"), "deep", "utf8");
    symlinkSync("..", join(root, "namespace", "cycle"), "dir");

    expect((await fingerprintSkillRoot(root, "global")).descriptors).toEqual(["namespace/deep/SKILL.md"]);
  });

  it("chooses one directory alias deterministically by bytewise logical path", async () => {
    const createAliasedRoot = (reverse: boolean): string => {
      const root = join(tempRoot(), "skills");
      mkdirSync(join(root, "z-target"), { recursive: true });
      writeFileSync(join(root, "z-target", "SKILL.md"), "aliased", "utf8");
      const aliases = reverse ? ["b-alias", "a-alias"] : ["a-alias", "b-alias"];
      for (const alias of aliases) symlinkSync("z-target", join(root, alias), "dir");
      return root;
    };

    const first = await fingerprintSkillRoot(createAliasedRoot(false), "global");
    const second = await fingerprintSkillRoot(createAliasedRoot(true), "global");

    expect(first.descriptors).toEqual(["a-alias/SKILL.md"]);
    expect(second).toEqual(first);
  });

  it("excludes file and directory symlinks whose targets resolve outside the controlled root", async () => {
    const root = join(tempRoot(), "skills");
    const external = tempRoot();
    mkdirSync(root);
    mkdirSync(join(external, "external-skill"));
    writeFileSync(join(external, "payload.md"), "outside file", "utf8");
    writeFileSync(join(external, "external-skill", "SKILL.md"), "outside directory", "utf8");
    const before = await fingerprintSkillRoot(root, "global");

    symlinkSync(join(external, "payload.md"), join(root, "outside.md"), "file");
    symlinkSync(join(external, "external-skill"), join(root, "outside-directory"), "dir");

    expect(await fingerprintSkillRoot(root, "global")).toEqual(before);
  });

  it("rejects an intermediate directory replaced by an out-of-root symlink after the descriptor opens", async () => {
    const root = join(tempRoot(), "skills");
    const namespace = join(root, "namespace");
    const openedNamespace = join(root, "namespace-opened");
    const externalNamespace = join(tempRoot(), "external-skill");
    mkdirSync(namespace, { recursive: true });
    mkdirSync(externalNamespace, { recursive: true });
    const descriptor = join(namespace, "SKILL.md");
    writeFileSync(descriptor, "inside", "utf8");
    writeFileSync(join(externalNamespace, "SKILL.md"), "outside", "utf8");
    const race = await mutateAfterDescriptorOpen(descriptor, () => {
      renameSync(namespace, openedNamespace);
      symlinkSync(externalNamespace, namespace, "dir");
    });

    try {
      await expect(fingerprintSkillRoot(root, "global")).rejects.toThrow(/changed/i);
      expect(race.didMutate()).toBe(true);
    } finally {
      race.restore();
    }
  });

  it("rejects an atomic descriptor replacement after the old inode opens", async () => {
    const root = join(tempRoot(), "skills");
    mkdirSync(root);
    const descriptor = join(root, "alpha.md");
    const replacement = join(root, "replacement.tmp");
    writeFileSync(join(root, "old-target.txt"), "alpha", "utf8");
    writeFileSync(join(root, "new-target.txt"), "bravo", "utf8");
    symlinkSync("old-target.txt", descriptor, "file");
    symlinkSync("new-target.txt", replacement, "file");
    const race = await mutateAfterDescriptorOpen(descriptor, () => {
      renameSync(replacement, descriptor);
    });

    try {
      await expect(fingerprintSkillRoot(root, "global")).rejects.toThrow(/changed/i);
      expect(race.didMutate()).toBe(true);
    } finally {
      race.restore();
    }
  });
});
