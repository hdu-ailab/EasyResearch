import { embeddedPackageVersion, isEmbeddedBuild } from "../runtime/bundled-assets";
import { stableNpmVersion } from "../runtime/npm-update-provenance";
import { performFirstRunSetup } from "./first-run";
import { revalidateNpmCandidate } from "./npm-update-candidate";
import { copyPiRuntimeAssets } from "./runtime-assets";

export interface NpmUpdateServeRequest { host: string; port: number; version: string; sha256: string }
export function parseNpmUpdateServeRequest(args: string[]): NpmUpdateServeRequest {
  const [entry, host, port, version, sha256] = args;
  if (args.length !== 5 || entry !== "--update-serve" || !host || !Number.isInteger(Number(port))
    || Number(port) < 1 || Number(port) > 65535 || !stableNpmVersion(version)
    || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid npm update launch contract.");
  return { host, port: Number(port), version, sha256 };
}

/** Only the verified successor uses this entry; ordinary bare --serve still skips setup. */
export async function prepareNpmUpdateBoot(request: NpmUpdateServeRequest, agentDir: string, options: {
  version?: string; embedded?: boolean; executable?: string;
  verify?: typeof revalidateNpmCandidate; setup?: typeof performFirstRunSetup; copyAssets?: typeof copyPiRuntimeAssets;
} = {}): Promise<void> {
  if (!(options.embedded ?? isEmbeddedBuild()) || request.version !== (options.version ?? embeddedPackageVersion())) {
    throw new Error("Npm update executable version does not match the selected candidate.");
  }
  await (options.verify ?? revalidateNpmCandidate)({ executable: options.executable ?? process.execPath, version: request.version, sha256: request.sha256, runtimeId: "" }, AbortSignal.timeout(30_000));
  (options.setup ?? performFirstRunSetup)(agentDir, { skipSetup: false, log: (message) => console.log(`[easyresearch] ${message}`) });
  (options.copyAssets ?? copyPiRuntimeAssets)(agentDir);
}
