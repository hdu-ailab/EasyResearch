import { join, dirname } from "path";
import { fileURLToPath } from "url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function importPi(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
	const previous = process.env.PI_PACKAGE_DIR;
	process.env.PI_PACKAGE_DIR = packageRoot;
	try {
		return await import("@earendil-works/pi-coding-agent");
	} finally {
		if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
		else process.env.PI_PACKAGE_DIR = previous;
	}
}