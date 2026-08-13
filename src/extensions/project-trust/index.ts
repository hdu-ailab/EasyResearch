import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * ADR-063: atomic extension answering `project_trust` with yes so project
 * config is always trusted (ADR-018), suppressing Pi's trust prompt.
 */
export function createProjectTrustExtension(): InlineExtension {
  return async (pi) => {
    pi.on("project_trust", () => ({ trusted: "yes" as const }));
  };
}

export default createProjectTrustExtension();
