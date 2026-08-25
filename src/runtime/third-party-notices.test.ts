import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  THIRD_PARTY_NOTICES_FILE,
  assertThirdPartyNoticesFile,
  collectThirdPartyNoticeEntries,
  generateThirdPartyNotices,
  renderThirdPartyNotices,
} from "../../scripts/third-party-notices";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const tempRoots: string[] = [];

const BOOLBASE_REVIEWED_TEXT = `Copyright (c) 2014-2015, Felix Boehm <me@feedic.com>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`;

interface NoticeFixturePackage {
  identity: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalPeers?: string[];
  notice?: string;
}

function identityName(identity: string): string {
  return identity.slice(0, identity.lastIndexOf("@"));
}

function identityVersion(identity: string): string {
  return identity.slice(identity.lastIndexOf("@") + 1);
}

function fixturePackageDir(root: string, lockKey: string): string {
  const segments = lockKey.split("/");
  const packageNames: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.startsWith("@")) {
      const scopedName = segments[index + 1];
      if (!scopedName) throw new Error(`Invalid scoped fixture lock key: ${lockKey}`);
      packageNames.push(`${segment}/${scopedName}`);
      index += 1;
    } else {
      packageNames.push(segment);
    }
  }
  let packageDir = join(root, "node_modules", packageNames[0]!);
  for (const packageName of packageNames.slice(1)) {
    packageDir = join(packageDir, "node_modules", packageName);
  }
  return packageDir;
}

function createNoticeFixture(input: {
  roots: string[];
  packages: Record<string, NoticeFixturePackage>;
}): string {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-notices-"));
  tempRoots.push(root);
  const lockPackages: Record<string, unknown[]> = {};
  for (const [lockKey, value] of Object.entries(input.packages)) {
    lockPackages[lockKey] = [
      value.identity,
      "",
      {
        dependencies: value.dependencies ?? {},
        optionalDependencies: value.optionalDependencies ?? {},
        peerDependencies: value.peerDependencies ?? {},
        optionalPeers: value.optionalPeers ?? [],
      },
      "fixture-integrity",
    ];
    const packageDir = fixturePackageDir(root, lockKey);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: identityName(value.identity),
        version: identityVersion(value.identity),
        license: "MIT",
      }),
    );
    writeFileSync(join(packageDir, "LICENSE"), "full fixture license text\n");
    if (value.notice) {
      writeFileSync(join(packageDir, "NOTICE"), `${value.notice}\n`);
    }
  }
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: Object.fromEntries(
        input.roots.map((identity) => [
          identityName(identity),
          identityVersion(identity),
        ]),
      ),
    }),
  );
  writeFileSync(
    join(root, "bun.lock"),
    JSON.stringify({
      lockfileVersion: 1,
      configVersion: 1,
      workspaces: {
        "": {
          dependencies: Object.fromEntries(
            input.roots.map((identity) => [
              identityName(identity),
              identityVersion(identity),
            ]),
          ),
        },
      },
      packages: lockPackages,
    }),
  );
  return root;
}

function readPackageManifest(root: string, lockKey: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(fixturePackageDir(root, lockKey), "package.json"), "utf8"),
  ) as Record<string, unknown>;
}

function writePackageManifest(
  root: string,
  lockKey: string,
  manifest: Record<string, unknown>,
): void {
  writeFileSync(
    join(fixturePackageDir(root, lockKey), "package.json"),
    JSON.stringify(manifest),
  );
}

function removeFixtureLicense(root: string, lockKey: string): void {
  unlinkSync(join(fixturePackageDir(root, lockKey), "LICENSE"));
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("third-party notice collection", () => {
  it("walks production edges, nested lock keys, installed optionals, and required peers", () => {
    const project = createNoticeFixture({
      roots: ["root-a@1.0.0", "root-b@2.0.0"],
      packages: {
        "root-a": {
          identity: "root-a@1.0.0",
          dependencies: { shared: "^1", nested: "^1" },
          optionalDependencies: {
            "optional-installed": "^1",
            "optional-absent": "^1",
          },
          peerDependencies: { peer: "^1", "optional-peer": "^1" },
          optionalPeers: ["optional-peer"],
          notice: "upstream fixture notice",
        },
        "root-a/nested": {
          identity: "nested@1.0.0",
          dependencies: { leaf: "^1" },
        },
        "root-a/nested/leaf": { identity: "leaf@1.0.0" },
        "root-b": {
          identity: "root-b@2.0.0",
          dependencies: { shared: "^1" },
        },
        shared: { identity: "shared@1.0.0" },
        "optional-installed": { identity: "optional-installed@1.0.0" },
        "optional-absent": { identity: "optional-absent@1.0.0" },
        peer: { identity: "peer@1.0.0" },
      },
    });
    rmSync(fixturePackageDir(project, "optional-absent"), {
      recursive: true,
      force: true,
    });

    const entries = collectThirdPartyNoticeEntries(project, [
      { name: "root-a", version: "1.0.0" },
      { name: "root-b", version: "2.0.0" },
    ]);

    expect(entries.map((entry) => `${entry.name}@${entry.version}`)).toEqual([
      "leaf@1.0.0",
      "nested@1.0.0",
      "optional-installed@1.0.0",
      "peer@1.0.0",
      "root-a@1.0.0",
      "root-b@2.0.0",
      "shared@1.0.0",
    ]);
    const notices = renderThirdPartyNotices(entries);
    expect(notices).toContain("full fixture license text");
    expect(notices).toContain("upstream fixture notice");
    expect(notices.endsWith("\n")).toBe(true);
  });

  it("walks scoped package lock keys and their nested production descendants", () => {
    const project = createNoticeFixture({
      roots: ["root-a@1.0.0"],
      packages: {
        "root-a": {
          identity: "root-a@1.0.0",
          dependencies: { "@fixture/scoped": "^1" },
        },
        "root-a/@fixture/scoped": {
          identity: "@fixture/scoped@1.0.0",
          dependencies: { leaf: "^1" },
        },
        "root-a/@fixture/scoped/leaf": { identity: "leaf@1.0.0" },
      },
    });

    const entries = collectThirdPartyNoticeEntries(project, [
      { name: "root-a", version: "1.0.0" },
    ]);

    expect(entries.map((entry) => `${entry.name}@${entry.version}`)).toEqual([
      "@fixture/scoped@1.0.0",
      "leaf@1.0.0",
      "root-a@1.0.0",
    ]);
    expect(
      existsSync(
        join(
          project,
          "node_modules/root-a/node_modules/@fixture/scoped/package.json",
        ),
      ),
    ).toBe(true);
  });

  it("resolves a deep dependency from its physical package ancestor", () => {
    const project = createNoticeFixture({
      roots: ["root-a@1.0.0"],
      packages: {
        "root-a": {
          identity: "root-a@1.0.0",
          dependencies: { container: "^1" },
        },
        "root-a/container": {
          identity: "container@1.0.0",
          dependencies: { nested: "^1" },
        },
        "root-a/container/nested": {
          identity: "nested@1.0.0",
          dependencies: { shared: "^1" },
        },
        "root-a/shared": { identity: "shared@1.0.0" },
      },
    });

    const entries = collectThirdPartyNoticeEntries(project, [
      { name: "root-a", version: "1.0.0" },
    ]);

    expect(entries.map((entry) => `${entry.name}@${entry.version}`)).toEqual([
      "container@1.0.0",
      "nested@1.0.0",
      "root-a@1.0.0",
      "shared@1.0.0",
    ]);
  });

  it("normalizes supported package license metadata forms", () => {
    const project = createNoticeFixture({
      roots: ["license-array@1.0.0", "license-object@1.0.0", "license-string@1.0.0"],
      packages: {
        "license-array": { identity: "license-array@1.0.0" },
        "license-object": { identity: "license-object@1.0.0" },
        "license-string": { identity: "license-string@1.0.0" },
      },
    });
    const arrayManifest = readPackageManifest(project, "license-array");
    delete arrayManifest.license;
    arrayManifest.licenses = ["MIT", { type: "ISC" }, "MIT"];
    writePackageManifest(project, "license-array", arrayManifest);
    const objectManifest = readPackageManifest(project, "license-object");
    objectManifest.license = { type: "Apache-2.0" };
    writePackageManifest(project, "license-object", objectManifest);

    const entries = collectThirdPartyNoticeEntries(project, [
      { name: "license-array", version: "1.0.0" },
      { name: "license-object", version: "1.0.0" },
      { name: "license-string", version: "1.0.0" },
    ]);

    expect(Object.fromEntries(entries.map((entry) => [entry.name, entry.license]))).toEqual({
      "license-array": "MIT OR ISC",
      "license-object": "Apache-2.0",
      "license-string": "MIT",
    });
  });

  it("rejects an entire deprecated licenses array when one member is unsupported", () => {
    const project = createNoticeFixture({
      roots: ["license-array@1.0.0"],
      packages: { "license-array": { identity: "license-array@1.0.0" } },
    });
    const manifest = readPackageManifest(project, "license-array");
    delete manifest.license;
    manifest.licenses = ["MIT", { type: "ISC" }, { type: "" }];
    writePackageManifest(project, "license-array", manifest);

    expect(() =>
      collectThirdPartyNoticeEntries(project, [
        { name: "license-array", version: "1.0.0" },
      ]),
    ).toThrow("Missing license metadata for license-array@1.0.0");
  });

  it("parses JSONC comments and trailing commas without changing punctuation in strings", () => {
    const project = createNoticeFixture({
      roots: ["root-a@1.0.0"],
      packages: {
        "root-a": {
          identity: "root-a@1.0.0",
          dependencies: { "child,}": "^1", "child,]": "^1" },
        },
        "child,}": { identity: "child,}@1.0.0" },
        "child,]": { identity: "child,]@1.0.0" },
      },
    });
    writeFileSync(
      join(project, "bun.lock"),
      `{
        // JSONC punctuation inside strings must remain byte-for-byte intact.
        "lockfileVersion": 1,
        "configVersion": 1,
        "workspaces": {
          "": {
            "dependencies": {
              "root-a": "1.0.0",
            },
          },
        },
        "packages": {
          "root-a": [
            "root-a@1.0.0",
            "fixture,}",
            {
              "dependencies": {
                "child,}": "^1",
                "child,]": "^1",
              },
            },
            "fixture-integrity",
          ],
          "child,}": ["child,}@1.0.0", "", {}, "fixture-integrity",],
          "child,]": ["child,]@1.0.0", "", {}, "fixture-integrity",],
        },
      }`,
    );

    const entries = collectThirdPartyNoticeEntries(project, [
      { name: "root-a", version: "1.0.0" },
    ]);

    expect(entries.map((entry) => `${entry.name}@${entry.version}`)).toEqual([
      "child,]@1.0.0",
      "child,}@1.0.0",
      "root-a@1.0.0",
    ]);
  });

  it("reads root legal files in code-point order and normalizes their newlines", () => {
    const project = createNoticeFixture({
      roots: ["root-a@1.0.0"],
      packages: { "root-a": { identity: "root-a@1.0.0" } },
    });
    const packageDir = fixturePackageDir(project, "root-a");
    writeFileSync(join(packageDir, "LICENCE-A"), "alpha\r\n\r\n");
    writeFileSync(join(packageDir, "LICENSE-z"), "zulu");
    writeFileSync(join(packageDir, "NOTICE.md"), "notice markdown\r\n");

    const [entry] = collectThirdPartyNoticeEntries(project, [
      { name: "root-a", version: "1.0.0" },
    ]);

    expect(entry?.licenseTexts).toEqual([
      { fileName: "LICENCE-A", text: "alpha\n" },
      { fileName: "LICENSE", text: "full fixture license text\n" },
      { fileName: "LICENSE-z", text: "zulu\n" },
    ]);
    expect(entry?.noticeTexts).toEqual([
      { fileName: "NOTICE.md", text: "notice markdown\n" },
    ]);
  });

  it("fails an unresolved required production dependency edge", () => {
    const project = createNoticeFixture({
      roots: ["root-a@1.0.0"],
      packages: {
        "root-a": {
          identity: "root-a@1.0.0",
          dependencies: { missing: "^1" },
        },
      },
    });

    expect(() =>
      collectThirdPartyNoticeEntries(project, [{ name: "root-a", version: "1.0.0" }]),
    ).toThrow("Unresolved production dependency missing from root-a");
  });

  it("fails when a requested root version differs from the lock", () => {
    const project = createNoticeFixture({
      roots: ["root-a@1.0.0"],
      packages: { "root-a": { identity: "root-a@1.0.0" } },
    });

    expect(() =>
      collectThirdPartyNoticeEntries(project, [{ name: "root-a", version: "2.0.0" }]),
    ).toThrow(/root-a@2\.0\.0.*root-a@1\.0\.0/);
  });

  it("fails when installed package identity differs from the lock", () => {
    const project = createNoticeFixture({
      roots: ["root-a@1.0.0"],
      packages: { "root-a": { identity: "root-a@1.0.0" } },
    });
    const manifest = readPackageManifest(project, "root-a");
    manifest.version = "9.9.9";
    writePackageManifest(project, "root-a", manifest);

    expect(() =>
      collectThirdPartyNoticeEntries(project, [{ name: "root-a", version: "1.0.0" }]),
    ).toThrow(/Installed package identity.*root-a@9\.9\.9.*root-a@1\.0\.0/);
  });

  it("fails when package license metadata is missing without an inspected override", () => {
    const project = createNoticeFixture({
      roots: ["root-a@1.0.0"],
      packages: { "root-a": { identity: "root-a@1.0.0" } },
    });
    const manifest = readPackageManifest(project, "root-a");
    delete manifest.license;
    writePackageManifest(project, "root-a", manifest);

    expect(() =>
      collectThirdPartyNoticeEntries(project, [{ name: "root-a", version: "1.0.0" }]),
    ).toThrow("Missing license metadata for root-a@1.0.0");
  });

  it("fails when an inspected required license file is missing", () => {
    const project = createNoticeFixture({
      roots: ["open-websearch@2.1.11"],
      packages: { "open-websearch": { identity: "open-websearch@2.1.11" } },
    });
    const manifest = readPackageManifest(project, "open-websearch");
    delete manifest.license;
    writePackageManifest(project, "open-websearch", manifest);
    removeFixtureLicense(project, "open-websearch");

    expect(() =>
      collectThirdPartyNoticeEntries(project, [
        { name: "open-websearch", version: "2.1.11" },
      ]),
    ).toThrow("Required license file LICENSE missing for open-websearch@2.1.11");
  });

  it("fails when the exact required license file is empty despite another license file", () => {
    const project = createNoticeFixture({
      roots: ["open-websearch@2.1.11"],
      packages: { "open-websearch": { identity: "open-websearch@2.1.11" } },
    });
    const manifest = readPackageManifest(project, "open-websearch");
    delete manifest.license;
    writePackageManifest(project, "open-websearch", manifest);
    const packageDir = fixturePackageDir(project, "open-websearch");
    writeFileSync(join(packageDir, "LICENSE"), "\r\n\r\n");
    writeFileSync(join(packageDir, "LICENSE-unrelated"), "unrelated legal text\n");

    expect(() =>
      collectThirdPartyNoticeEntries(project, [
        { name: "open-websearch", version: "2.1.11" },
      ]),
    ).toThrow("Empty required license file LICENSE for open-websearch@2.1.11");
  });

  it("fails an unreviewed package with metadata but no standalone license text", () => {
    const project = createNoticeFixture({
      roots: ["root-a@1.0.0"],
      packages: { "root-a": { identity: "root-a@1.0.0" } },
    });
    removeFixtureLicense(project, "root-a");

    expect(() =>
      collectThirdPartyNoticeEntries(project, [{ name: "root-a", version: "1.0.0" }]),
    ).toThrow("No reviewed license text for root-a@1.0.0");
  });

  it("fails when duplicate package identities carry differing legal bytes", () => {
    const project = createNoticeFixture({
      roots: ["root-a@1.0.0"],
      packages: {
        "root-a": {
          identity: "root-a@1.0.0",
          dependencies: { nested: "^1", same: "^1" },
        },
        "root-a/nested": {
          identity: "nested@1.0.0",
          dependencies: { same: "^1" },
        },
        "root-a/nested/same": { identity: "same@1.0.0" },
        same: { identity: "same@1.0.0" },
      },
    });
    writeFileSync(
      join(fixturePackageDir(project, "root-a/nested/same"), "LICENSE"),
      "different legal text\n",
    );

    expect(() =>
      collectThirdPartyNoticeEntries(project, [{ name: "root-a", version: "1.0.0" }]),
    ).toThrow("Conflicting legal material for same@1.0.0");
  });

  it("fails when the lock contains multiple Axios identities", () => {
    const project = createNoticeFixture({
      roots: ["axios@1.19.0", "helper@1.0.0"],
      packages: {
        axios: { identity: "axios@1.19.0" },
        helper: {
          identity: "helper@1.0.0",
          dependencies: { axios: "^1.18.0" },
        },
        "helper/axios": { identity: "axios@1.18.0" },
      },
    });

    expect(() =>
      collectThirdPartyNoticeEntries(project, [
        { name: "axios", version: "1.19.0" },
        { name: "helper", version: "1.0.0" },
      ]),
    ).toThrow(/Multiple Axios lock identities.*axios@1\.18\.0.*axios@1\.19\.0/);
  });

  it("uses audited exact-version text only when its reviewed bytes match", () => {
    const project = createNoticeFixture({
      roots: ["boolbase@1.0.0"],
      packages: { boolbase: { identity: "boolbase@1.0.0" } },
    });
    const manifest = readPackageManifest(project, "boolbase");
    manifest.license = "ISC";
    writePackageManifest(project, "boolbase", manifest);
    removeFixtureLicense(project, "boolbase");
    const reviewedFile = join(project, "scripts/licenses/boolbase-1.0.0.txt");
    mkdirSync(dirname(reviewedFile), { recursive: true });
    writeFileSync(reviewedFile, BOOLBASE_REVIEWED_TEXT);

    const [entry] = collectThirdPartyNoticeEntries(project, [
      { name: "boolbase", version: "1.0.0" },
    ]);
    expect(entry?.licenseTexts).toEqual([
      { fileName: basename(reviewedFile), text: BOOLBASE_REVIEWED_TEXT },
    ]);

    writeFileSync(reviewedFile, `${BOOLBASE_REVIEWED_TEXT}tampered\n`);
    expect(() =>
      collectThirdPartyNoticeEntries(project, [
        { name: "boolbase", version: "1.0.0" },
      ]),
    ).toThrow("Reviewed license hash mismatch for boolbase@1.0.0");
  });

  it("accepts audited text when a Windows checkout converts LF to CRLF", () => {
    const project = createNoticeFixture({
      roots: ["boolbase@1.0.0"],
      packages: { boolbase: { identity: "boolbase@1.0.0" } },
    });
    const manifest = readPackageManifest(project, "boolbase");
    manifest.license = "ISC";
    writePackageManifest(project, "boolbase", manifest);
    removeFixtureLicense(project, "boolbase");
    const reviewedFile = join(project, "scripts/licenses/boolbase-1.0.0.txt");
    mkdirSync(dirname(reviewedFile), { recursive: true });
    writeFileSync(reviewedFile, BOOLBASE_REVIEWED_TEXT.replaceAll("\n", "\r\n"));

    const [entry] = collectThirdPartyNoticeEntries(project, [
      { name: "boolbase", version: "1.0.0" },
    ]);

    expect(entry?.licenseTexts).toEqual([
      { fileName: basename(reviewedFile), text: BOOLBASE_REVIEWED_TEXT },
    ]);
  });

  it("does not reuse an audited text override for another package version", () => {
    const project = createNoticeFixture({
      roots: ["boolbase@1.0.1"],
      packages: { boolbase: { identity: "boolbase@1.0.1" } },
    });
    const manifest = readPackageManifest(project, "boolbase");
    manifest.license = "ISC";
    writePackageManifest(project, "boolbase", manifest);
    removeFixtureLicense(project, "boolbase");
    const reviewedFile = join(project, "scripts/licenses/boolbase-1.0.0.txt");
    mkdirSync(dirname(reviewedFile), { recursive: true });
    writeFileSync(reviewedFile, BOOLBASE_REVIEWED_TEXT);

    expect(() =>
      collectThirdPartyNoticeEntries(project, [
        { name: "boolbase", version: "1.0.1" },
      ]),
    ).toThrow("No reviewed license text for boolbase@1.0.1");
  });

  it("extracts a reviewed README section only for its exact package version", () => {
    const project = createNoticeFixture({
      roots: ["cookie-signature@1.0.7"],
      packages: { "cookie-signature": { identity: "cookie-signature@1.0.7" } },
    });
    removeFixtureLicense(project, "cookie-signature");
    writeFileSync(
      join(fixturePackageDir(project, "cookie-signature"), "Readme.md"),
      "Package information\r\n\r\n## License\r\n\r\nMIT fixture license text\r\n",
    );

    const [entry] = collectThirdPartyNoticeEntries(project, [
      { name: "cookie-signature", version: "1.0.7" },
    ]);
    expect(entry?.licenseTexts).toEqual([
      {
        fileName: "Readme.md",
        text: "## License\n\nMIT fixture license text\n",
      },
    ]);

    const manifest = readPackageManifest(project, "cookie-signature");
    manifest.version = "1.0.8";
    writePackageManifest(project, "cookie-signature", manifest);
    const lock = JSON.parse(readFileSync(join(project, "bun.lock"), "utf8")) as {
      packages: Record<string, unknown[]>;
      workspaces: Record<string, { dependencies: Record<string, string> }>;
    };
    lock.packages["cookie-signature"]![0] = "cookie-signature@1.0.8";
    lock.workspaces[""]!.dependencies["cookie-signature"] = "1.0.8";
    writeFileSync(join(project, "bun.lock"), JSON.stringify(lock));
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: { "cookie-signature": "1.0.8" },
      }),
    );

    expect(() =>
      collectThirdPartyNoticeEntries(project, [
        { name: "cookie-signature", version: "1.0.8" },
      ]),
    ).toThrow("No reviewed license text for cookie-signature@1.0.8");
  });

  it("rejects a README heading that only contains the configured heading as a prefix", () => {
    const project = createNoticeFixture({
      roots: ["cookie-signature@1.0.7"],
      packages: { "cookie-signature": { identity: "cookie-signature@1.0.7" } },
    });
    removeFixtureLicense(project, "cookie-signature");
    writeFileSync(
      join(fixturePackageDir(project, "cookie-signature"), "Readme.md"),
      "Package information\n\n## Licenses\n\nMIT fixture license text\n",
    );

    expect(() =>
      collectThirdPartyNoticeEntries(project, [
        { name: "cookie-signature", version: "1.0.7" },
      ]),
    ).toThrow("Reviewed README heading missing for cookie-signature@1.0.7: ## License");
  });

  it("extracts an exact reviewed underlined multi-line README heading", () => {
    const project = createNoticeFixture({
      roots: ["https-proxy-agent@5.0.1"],
      packages: { "https-proxy-agent": { identity: "https-proxy-agent@5.0.1" } },
    });
    removeFixtureLicense(project, "https-proxy-agent");
    writeFileSync(
      join(fixturePackageDir(project, "https-proxy-agent"), "README.md"),
      "Package information\r\n\r\nLicense\r\n-------\r\n\r\nMIT fixture license text\r\n",
    );

    const [entry] = collectThirdPartyNoticeEntries(project, [
      { name: "https-proxy-agent", version: "5.0.1" },
    ]);

    expect(entry?.licenseTexts).toEqual([
      {
        fileName: "README.md",
        text: "License\n-------\n\nMIT fixture license text\n",
      },
    ]);
  });
});

describe("third-party notice rendering and file validation", () => {
  it("renders entries in deterministic identity order without build-specific data", () => {
    const rendered = renderThirdPartyNotices([
      {
        name: "z-package",
        version: "1.0.0",
        license: "MIT",
        licenseTexts: [{ fileName: "LICENSE", text: "z license\n" }],
        noticeTexts: [],
      },
      {
        name: "a-package",
        version: "2.0.0",
        license: "ISC",
        licenseTexts: [{ fileName: "LICENCE", text: "a license\n" }],
        noticeTexts: [{ fileName: "NOTICE", text: "a notice\n" }],
      },
    ]);

    expect(rendered).toBe(`================================================================================
a-package@2.0.0
License: ISC
--- LICENCE ---
a license
--- NOTICE ---
a notice

================================================================================
z-package@1.0.0
License: MIT
--- LICENSE ---
z license
`);
  });

  it("distinguishes missing notice files from changed UTF-8 bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "easyresearch-notice-file-"));
    tempRoots.push(root);
    const filePath = join(root, THIRD_PARTY_NOTICES_FILE);

    expect(() => assertThirdPartyNoticesFile(filePath, "expected\n")).toThrow(
      `Missing third-party notices file: ${filePath}`,
    );
    writeFileSync(filePath, "changed\n", "utf8");
    expect(() => assertThirdPartyNoticesFile(filePath, "expected\n")).toThrow(
      `Changed third-party notices file: ${filePath}`,
    );
    writeFileSync(filePath, "expected\n", "utf8");
    expect(() => assertThirdPartyNoticesFile(filePath, "expected\n")).not.toThrow();
    expect(existsSync(filePath)).toBe(true);
  });
});

describe("installed third-party closure", () => {
  it("collects the complete locked Web-search, Axios, and SSH production closure", () => {
    const entries = collectThirdPartyNoticeEntries(PROJECT_ROOT);
    const identities = entries.map((entry) => `${entry.name}@${entry.version}`);
    const first = generateThirdPartyNotices(PROJECT_ROOT);
    const second = generateThirdPartyNotices(PROJECT_ROOT);

    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
    expect(identities).toContain("axios@1.19.0");
    expect(identities).toContain("open-websearch@2.1.11");
    expect(identities).toContain("ssh2@1.17.0");
    expect(identities).toContain("bcrypt-pbkdf@1.0.2");
    expect(identities).toContain("boolbase@1.0.0");
    expect(identities).toContain("saxes@6.0.0");
    expect(identities).toContain("cookie-signature@1.0.7");
    expect(identities).toContain("https-proxy-agent@5.0.1");
    expect(identities).toContain("agent-base@6.0.2");
    expect(first).toContain("Apache License");
    const scopedIdentities = entries
      .filter((entry) => entry.name.startsWith("@"))
      .map((entry) => `${entry.name}@${entry.version}`);
    expect(scopedIdentities.length).toBeGreaterThan(0);
    expect(
      scopedIdentities.every((identity) => first.includes(`\n${identity}\n`)),
    ).toBe(true);
  });
});
