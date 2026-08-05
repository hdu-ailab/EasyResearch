import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const previous = process.env.PI_PACKAGE_DIR;
process.env.PI_PACKAGE_DIR = packageRoot;
const { main } = await import("@earendil-works/pi-coding-agent");
if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
else process.env.PI_PACKAGE_DIR = previous;
await main(process.argv.slice(2));