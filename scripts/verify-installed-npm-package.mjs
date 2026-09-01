#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyInstalledNpmPackage } from "./verify-installed-npm-package-support.mjs";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const result = await verifyInstalledNpmPackage({
  version: packageJson.version,
  log: (message) => console.log(message),
});
console.log(`[installed-npm] verified easyresearch@${result.version} through ${result.binPath}`);
