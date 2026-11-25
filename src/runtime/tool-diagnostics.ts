/** Safe observational metadata; never includes native exception text. */
export interface ToolDiagnosticDto {
  kind: "load" | "registration";
  path: string;
  scope?: "global" | "project";
}

export interface RuntimeToolError {
  path: string;
  kind?: ToolDiagnosticDto["kind"];
  scope?: "user" | "project";
}

export interface NativeExtensionDiagnostics {
  extensions?: readonly { path: string; sourceInfo?: { scope?: string } }[];
  errors: readonly { path: string; scope?: "user" | "project" }[];
}

/** Native loaded paths distinguish registration conflicts from failed factories/imports. */
export function observeToolDiagnostics(result: NativeExtensionDiagnostics | undefined): RuntimeToolError[] {
  const loaded = new Map(result?.extensions?.map(extension => [extension.path, extension]));
  return (result?.errors ?? []).map(error => {
    const scope = error.scope ?? loaded.get(error.path)?.sourceInfo?.scope;
    return {
      path: error.path,
      kind: loaded.has(error.path) ? "registration" : "load",
      ...(scope === "user" || scope === "project" ? { scope } : {}),
    };
  });
}
