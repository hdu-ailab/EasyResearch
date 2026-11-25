import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExtensionWatchFilter,
  extensionWatchAnchors,
  fingerprintExtensionResources,
  MAX_EXTENSION_DEPTH,
  MAX_EXTENSION_SOURCE_BYTES,
} from "./extension-resources";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-extension-resources-"));
  roots.push(root);
  const config = join(root, "agent");
  const extensions = join(config, "extensions");
  mkdirSync(config);
  return { root, config, extensions };
}

function write(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

describe("extension resource fingerprints", () => {
  it("is content-deterministic across identical configuration roots and directory insertion orders", async () => {
    const first = fixture();
    const second = fixture();
    expect(await fingerprintExtensionResources(first.config)).toEqual(await fingerprintExtensionResources(second.config));
    write(join(first.extensions, "a.ts"), "alpha");
    write(join(first.extensions, "bundle", "helper.json"), '{"value":1}');
    write(join(second.extensions, "bundle", "helper.json"), '{"value":1}');
    write(join(second.extensions, "a.ts"), "alpha");
    expect(await fingerprintExtensionResources(first.config)).toEqual(await fingerprintExtensionResources(second.config));
  });

  it("hashes source bytes rather than mtime and never evaluates authored code", async () => {
    const { root, config, extensions } = fixture();
    const file = join(extensions, "custom.ts");
    const executed = join(root, "executed");
    write(file, `require("node:fs").writeFileSync(${JSON.stringify(executed)}, "one")`);
    const before = await fingerprintExtensionResources(config);
    const times = statSync(file);
    write(file, `require("node:fs").writeFileSync(${JSON.stringify(executed)}, "two")`);
    utimesSync(file, times.atime, times.mtime);
    const after = await fingerprintExtensionResources(config);
    expect(after.value).not.toBe(before.value);
    utimesSync(file, new Date(), new Date());
    expect(await fingerprintExtensionResources(config)).toEqual(after);
    expect(existsSync(executed)).toBe(false);
  });

  it.each(["ts", "js", "mjs", "cjs", "mts", "cts", "json"])("includes nested %s helpers without guessing entrypoints", async (suffix) => {
    const { config, extensions } = fixture();
    write(join(extensions, "bundle", "index.ts"), "export default () => {}");
    const helper = join(extensions, "bundle", "src", `helper.${suffix}`);
    write(helper, "first");
    const before = await fingerprintExtensionResources(config);
    write(helper, "other");
    expect((await fingerprintExtensionResources(config)).value).not.toBe(before.value);
  });

  it("detects first creation, unlink, empty directories, package selection and replaced directories", async () => {
    const { root, config, extensions } = fixture();
    const missing = await fingerprintExtensionResources(config);
    const source = join(extensions, "tool", "index.ts");
    write(source, "one");
    const created = await fingerprintExtensionResources(config);
    expect(created.value).not.toBe(missing.value);
    write(join(extensions, "tool", "package.json"), JSON.stringify({ pi: { extensions: ["index.ts"] } }));
    const manifest = await fingerprintExtensionResources(config);
    expect(manifest.value).not.toBe(created.value);
    mkdirSync(join(extensions, "helpers"));
    const withDirectory = await fingerprintExtensionResources(config);
    expect(withDirectory.value).not.toBe(manifest.value);
    rmSync(join(extensions, "helpers"), { recursive: true });
    expect(await fingerprintExtensionResources(config)).toEqual(manifest);
    renameSync(join(extensions, "tool"), join(root, "previous-tool"));
    write(source, "two");
    const replaced = await fingerprintExtensionResources(config);
    expect(replaced.value).not.toBe(manifest.value);
    unlinkSync(source);
    expect((await fingerprintExtensionResources(config)).value).not.toBe(replaced.value);
  });

  it("ignores dependency, repository and non-source payloads while retaining authored dot directories", async () => {
    const { config, extensions } = fixture();
    write(join(extensions, "tool.ts"), "export {};");
    const before = await fingerprintExtensionResources(config);
    write(join(extensions, "node_modules", "unrelated", "huge.ts"), "x".repeat(MAX_EXTENSION_SOURCE_BYTES + 1));
    write(join(extensions, ".git", "objects", "unrelated.json"), "ignored");
    write(join(extensions, "notes.txt"), "ignored");
    expect(await fingerprintExtensionResources(config)).toEqual(before);
    write(join(extensions, ".helpers", "hidden.ts"), "authored");
    expect((await fingerprintExtensionResources(config)).value).not.toBe(before.value);
  });

  it("uses only the exact configuration root and native extension selection, tolerating the settings BOM", async () => {
    const { root, config, extensions } = fixture();
    write(join(extensions, "one.ts"), "one");
    const before = await fingerprintExtensionResources(config);
    write(join(root, ".easyresearch", "extensions", "ancestor.ts"), "inert");
    write(join(root, "paper", ".easyresearch", "extensions", "other-project.ts"), "inert");
    write(join(config, "settings.json"), '\uFEFF{"unrelated":true}');
    expect(await fingerprintExtensionResources(config)).toEqual(before);
    write(join(config, "settings.json"), '\uFEFF{"extensions":["!extensions/one.ts"],"unrelated":true}');
    const disabled = await fingerprintExtensionResources(config);
    expect(disabled.value).not.toBe(before.value);
    write(join(config, "settings.json"), '{"extensions":["!extensions/one.ts"],"unrelated":false}');
    expect(await fingerprintExtensionResources(config)).toEqual(disabled);
    write(join(config, "settings.json"), '{"extensions":["!extensions/one.ts","+extensions/one.ts"]}');
    expect((await fingerprintExtensionResources(config)).value).not.toBe(disabled.value);
  });

  it("detects explicit local file and directory edits during preflight with config-relative and home paths", async () => {
    const { root, config } = fixture();
    const home = join(root, "home");
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const first = join(root, "outside", "one.ts");
    const helper = join(home, "authored", "helpers", "input.json");
    write(first, "first");
    write(helper, '{"value":1}');
    write(join(config, "settings.json"), '\uFEFF{"extensions":["../outside/one.ts","~/authored"]}');
    const before = await fingerprintExtensionResources(config);
    write(first, "other");
    const afterFile = await fingerprintExtensionResources(config);
    expect(afterFile.value).not.toBe(before.value);
    write(helper, '{"value":2}');
    const afterHelper = await fingerprintExtensionResources(config);
    expect(afterHelper.value).not.toBe(afterFile.value);
    write(join(config, "settings.json"), JSON.stringify({ extensions: [first] }));
    const selectedFile = await fingerprintExtensionResources(config);
    write(helper, '{"value":3}');
    expect(await fingerprintExtensionResources(config)).toEqual(selectedFile);
  });

  it("tracks missing explicit sources and their later creation without loading packages or broad roots", async () => {
    const { root, config } = fixture();
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    const source = join(root, "external", "later.ts");
    write(join(config, "settings.json"), JSON.stringify({
      extensions: [source, "..", "~", "npm:unavailable", "git:unavailable", "builtin:mcp", "*.ts", "!ignored", "+ignored"],
      packages: ["npm:never-install"],
    }));
    const before = await fingerprintExtensionResources(config);
    write(join(root, "noise.ts"), "out of scope");
    expect(await fingerprintExtensionResources(config)).toEqual(before);
    write(source, "export {};");
    expect((await fingerprintExtensionResources(config)).value).not.toBe(before.value);
  });

  it("fingerprints linked source bytes for preflight, handles cycles, and does not traverse excluded target trees", async () => {
    const { root, config, extensions } = fixture();
    const target = join(root, "authored", "tool.ts");
    write(target, "one");
    mkdirSync(extensions);
    symlinkSync(target, join(extensions, "linked.ts"), "file");
    symlinkSync(extensions, join(extensions, "cycle"), "dir");
    const ignored = join(root, "node_modules", "huge.ts");
    write(ignored, "x".repeat(MAX_EXTENSION_SOURCE_BYTES + 1));
    symlinkSync(ignored, join(extensions, "ignored.ts"), "file");
    const before = await fingerprintExtensionResources(config);
    write(target, "two");
    expect((await fingerprintExtensionResources(config)).value).not.toBe(before.value);
  });

  it("retains malformed settings as opaque change evidence and recovers without exposing parser input", async () => {
    const { config } = fixture();
    write(join(config, "settings.json"), '{"extensions": secret-one');
    const before = await fingerprintExtensionResources(config);
    write(join(config, "settings.json"), '{"extensions": secret-two');
    expect((await fingerprintExtensionResources(config)).value).not.toBe(before.value);
    write(join(config, "settings.json"), "{}");
    expect((await fingerprintExtensionResources(config)).value).not.toBe(before.value);
  });

  it("rejects excessive source size and traversal depth with a safe source diagnostic", async () => {
    const { config, extensions } = fixture();
    const file = join(extensions, "large.ts");
    write(file, "x".repeat(MAX_EXTENSION_SOURCE_BYTES + 1));
    await expect(fingerprintExtensionResources(config)).rejects.toMatchObject({ path: file, category: "read" });
    unlinkSync(file);
    const deep = join(extensions, ...Array.from({ length: MAX_EXTENSION_DEPTH + 1 }, (_, index) => `d${index}`));
    mkdirSync(deep, { recursive: true });
    await expect(fingerprintExtensionResources(config)).rejects.toThrow(/Configuration read failed/);
  });
});

describe("bounded extension watcher admission", () => {
  it("anchors every authored directory name for atomic replacement without traversing linked or dependency trees", async () => {
    const { root, extensions } = fixture();
    expect(await extensionWatchAnchors(extensions)).toEqual([extensions]);
    const nested = join(extensions, "tool", "src");
    write(join(nested, "helper.ts"), "source");
    write(join(extensions, "node_modules", "package", "index.ts"), "inert");
    write(join(extensions, ".git", "objects", "index.ts"), "inert");
    write(join(root, "outside", "src", "index.ts"), "external");
    symlinkSync(join(root, "outside"), join(extensions, "linked"), "dir");
    const anchors = await extensionWatchAnchors(extensions);
    expect(anchors).toEqual([extensions, join(extensions, "tool"), nested]);
    rmSync(join(extensions, "tool"), { recursive: true });
    expect(await extensionWatchAnchors(extensions)).toEqual([extensions]);
  });

  it("admits source files and directory add/unlink while excluding payloads and linked descendants", () => {
    const { root, extensions } = fixture();
    const directory = join(extensions, "bundle");
    const source = join(directory, "helper.json");
    write(source, "{}");
    write(join(directory, "notes.txt"), "ignored");
    const external = join(root, "outside");
    write(join(external, "helper.ts"), "outside");
    symlinkSync(external, join(extensions, "linked"), "dir");
    const allowed = createExtensionWatchFilter(extensions);
    expect(allowed(source)).toBe(true);
    expect(allowed(directory)).toBe(true);
    expect(allowed(join(directory, "notes.txt"))).toBe(false);
    expect(allowed(join(extensions, "linked"))).toBe(true);
    expect(allowed(join(extensions, "linked", "helper.ts"))).toBe(false);
    expect(allowed(join(external, "helper.ts"))).toBe(false);
    expect(allowed(join(extensions, "node_modules", "helper.ts"))).toBe(false);
    expect(allowed(join(extensions, ".git", "config.json"))).toBe(false);
    rmSync(directory, { recursive: true });
    expect(allowed(directory)).toBe(true);
    expect(allowed(source)).toBe(true);
  });
});
