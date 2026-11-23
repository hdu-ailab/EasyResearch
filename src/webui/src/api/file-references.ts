import type { FileReferencesResolvedDto } from "../../../web/file-reference-contracts";
import { isAbsoluteFilesystemPath } from "../filesystem-path";
import { routes } from "./routes";
import { requestJson } from "./transport";

export function parseFileReferences(value: unknown): FileReferencesResolvedDto {
  const invalid = () => new Error("Invalid file reference response");
  if (
    !value ||
    typeof value !== "object" ||
    !("references" in value) ||
    !Array.isArray(value.references) ||
    value.references.length > 64
  )
    throw invalid();
  const seen = new Set<string>();
  return {
    references: value.references.map((entry: unknown) => {
      if (!entry || typeof entry !== "object") throw invalid();
      const source = entry as Record<string, unknown>;
      if (
        typeof source.reference !== "string" ||
        !source.reference ||
        source.reference.length > 4096 ||
        seen.has(source.reference) ||
        typeof source.truncated !== "boolean" ||
        !Array.isArray(source.paths) ||
        source.paths.length > 128 ||
        !source.paths.every(
          (path) =>
            typeof path === "string" &&
            path.length <= 32768 &&
            !/[\p{Cc}]/u.test(path) &&
            isAbsoluteFilesystemPath(path),
        )
      )
        throw invalid();
      seen.add(source.reference);
      return { reference: source.reference, paths: [...new Set<string>(source.paths)], truncated: source.truncated };
    }),
  };
}

export function resolveFileReferences(id: string, references: string[], signal?: AbortSignal) {
  return requestJson(routes.fileReferences(id), parseFileReferences, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ references }),
    signal,
  });
}
