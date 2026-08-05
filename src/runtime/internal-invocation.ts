import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface InternalPiInvocation {
  command: string;
  args: string[];
}

const bootstrapPath = join(dirname(fileURLToPath(import.meta.url)), "pi-bootstrap.mjs");

export function getInternalPiInvocation(): InternalPiInvocation {
  return { command: process.execPath, args: [bootstrapPath] };
}