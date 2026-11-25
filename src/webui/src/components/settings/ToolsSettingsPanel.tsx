import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentDto, ToolDiagnosticDto } from "../../../../web/contracts";
import { listAgents, refreshConfigurationResources } from "../../api";
import { useI18n } from "../../i18n/useI18n";
import { PanelHeading } from "./SettingsPanels";

interface InventoryState {
  scope: string;
  agents?: readonly AgentDto[];
  loading: boolean;
  manual: boolean;
  error: "read" | "refresh" | null;
}

interface InventoryRequest {
  scope: string;
  controller: AbortController;
  phase: "read" | "refresh";
  manual: boolean;
}

function diagnosticKey(diagnostic: ToolDiagnosticDto): string {
  return JSON.stringify([diagnostic.kind, diagnostic.scope ?? null, diagnostic.path]);
}

export function ToolsSettingsPanel({
  active,
  scope,
  projects,
  configurationGeneration,
  mutationRevision,
  onScopeChange,
}: {
  active: boolean;
  scope: string;
  projects: readonly { cwd: string }[];
  configurationGeneration: number;
  mutationRevision: number;
  onScopeChange(scope: string): void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<InventoryState>({ scope, loading: false, manual: false, error: null });
  const owner = useRef<InventoryRequest | null>(null);
  const view = useRef({ active, scope });
  view.current = { active, scope };
  const cancel = useCallback(() => {
    const previous = owner.current;
    owner.current = null;
    previous?.controller.abort();
  }, []);
  // View cleanup is separate from configuration invalidation: inventory events
  // arriving during manual synchronization must not start an early read.
  useLayoutEffect(() => {
    void active;
    void scope;
    return cancel;
  }, [active, scope, cancel]);
  const refresh = useCallback(
    async (manual = false) => {
      const current = view.current;
      if (!current.active) return;
      if (owner.current?.phase === "refresh" || (manual && owner.current?.manual)) return;
      cancel();
      const request: InventoryRequest = {
        scope: current.scope,
        controller: new AbortController(),
        manual,
        phase: manual ? "refresh" : "read",
      };
      owner.current = request;
      const owns = () =>
        owner.current === request &&
        !request.controller.signal.aborted &&
        view.current.active &&
        view.current.scope === request.scope;
      setState((previous) => ({
        scope: request.scope,
        agents: previous.scope === request.scope ? previous.agents : undefined,
        loading: true,
        manual,
        error: null,
      }));
      try {
        let refreshFailed = false;
        if (manual) {
          const result = await refreshConfigurationResources(
            request.scope === "global" ? {} : { projectCwds: [request.scope] },
          );
          if (!owns()) return;
          refreshFailed = result.error !== null;
          request.phase = "read";
        }
        const agents = await listAgents(
          request.scope === "global" ? undefined : request.scope,
          request.controller.signal,
        );
        if (owns())
          setState({
            scope: request.scope,
            agents,
            loading: false,
            manual: false,
            error: refreshFailed ? "refresh" : null,
          });
      } catch {
        if (owns())
          setState((previous) => ({
            ...previous,
            loading: false,
            manual: false,
            error: request.phase,
          }));
      } finally {
        if (owner.current === request) owner.current = null;
      }
    },
    [cancel],
  );
  useEffect(() => {
    void scope;
    void configurationGeneration;
    void mutationRevision;
    if (active) void refresh();
  }, [active, scope, configurationGeneration, mutationRevision, refresh]);

  // Never expose another scope's cached tools, diagnostics or error while its
  // successor read is pending, including the render before the effect runs.
  const current = state.scope === scope ? state : undefined;
  const tools = [...new Set(current?.agents?.flatMap((agent) => agent.effectiveTools ?? []) ?? [])].sort((a, b) =>
    a.localeCompare(b),
  );
  // The producer supplies bounded, safe path-bearing records shared across
  // Agents. Deduplicate structured identity, never object identity or prose.
  const diagnostics = [
    ...new Map(
      (current?.agents?.flatMap((agent) => agent.toolDiagnostics ?? []) ?? []).map((diagnostic) => [
        diagnosticKey(diagnostic),
        diagnostic,
      ]),
    ).values(),
  ];
  const truncated = current?.agents?.some((agent) => agent.toolDiagnosticsTruncated === true) ?? false;
  const loading = current?.loading ?? active;
  const manualBusy = current?.manual && loading;
  return (
    <section aria-label={t("settings.resources.tools")} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PanelHeading>{t("settings.resources.tools")}</PanelHeading>
        <button
          type="button"
          disabled={manualBusy}
          onClick={() => void refresh(true)}
          className="flex min-h-9 items-center gap-1 rounded-md border border-v2-grey-200 px-3 text-[12px] hover:bg-v2-grey-100 disabled:opacity-40"
        >
          <RefreshCw size={13} aria-hidden />
          {t("tools.refresh")}
        </button>
      </div>
      <select
        aria-label={t("settings.resources.toolScope")}
        value={scope}
        className="min-h-9 min-w-0 max-w-full self-start rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 text-[12px] text-v2-text-text-base focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600"
        onChange={(event) => {
          cancel();
          onScopeChange(event.target.value);
        }}
      >
        <option value="global">{t("config.global")}</option>
        {scope !== "global" && !projects.some((project) => project.cwd === scope) && (
          <option value={scope}>{scope}</option>
        )}
        {projects.map((project) => (
          <option key={project.cwd} value={project.cwd}>
            {project.cwd}
          </option>
        ))}
      </select>
      {loading && (
        <p role="status" className="text-[12px] text-v2-text-text-muted">
          {t("tools.loading")}
        </p>
      )}
      {current?.error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-md border border-v2-status-error/30 px-3 py-2 text-[12px] text-v2-status-error"
        >
          <p>
            {t(current.error === "refresh" ? "tools.refreshError" : "tools.readError")}
            {current.agents && ` ${t("tools.cached")}`}
          </p>
          <button
            type="button"
            disabled={manualBusy}
            onClick={() => void refresh(true)}
            className="min-h-8 rounded px-2 underline underline-offset-2 disabled:opacity-40"
          >
            {t("dialog.retry")}
          </button>
        </div>
      )}
      {(["load", "registration"] as const).map((kind) => {
        const records = diagnostics.filter((diagnostic) => diagnostic.kind === kind);
        if (records.length === 0) return null;
        const count = new Set(records.map((diagnostic) => diagnostic.path)).size;
        return (
          <section key={kind} className="min-w-0 rounded-md border border-v2-grey-200 p-3">
            <p
              role="status"
              data-tool-diagnostics-summary={kind}
              data-count={count}
              data-truncated={truncated}
              className="text-[13px] text-v2-text-text-base"
            >
              {t(
                kind === "load"
                  ? truncated
                    ? "tools.atLeastLoadFailures"
                    : "tools.loadFailures"
                  : truncated
                    ? "tools.atLeastRegistrationIssues"
                    : "tools.registrationIssues",
              ).replace("{n}", String(count))}
            </p>
            <ul
              aria-label={t(kind === "load" ? "tools.failedExtensions" : "tools.registrationExtensions")}
              className="mt-2 list-inside list-disc break-words text-[12px] text-v2-text-text-muted"
            >
              {records.map((diagnostic) => (
                <li
                  key={diagnosticKey(diagnostic)}
                  data-tool-diagnostic-kind={kind}
                  className="[overflow-wrap:anywhere]"
                >
                  {diagnostic.scope && (
                    <span className="mr-2">
                      {t(diagnostic.scope === "global" ? "config.global" : "config.project")}
                    </span>
                  )}
                  <code>{diagnostic.path}</code>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {truncated && (
        <p role="status" className="text-[12px] text-v2-text-text-muted">
          {t("tools.truncated")}
        </p>
      )}
      {current?.agents !== undefined &&
        (tools.length > 0 ? (
          <ul aria-label={t("tools.loaded")} className="flex flex-wrap gap-1.5">
            {tools.map((tool) => (
              <li
                key={tool}
                className="max-w-full rounded-md border border-v2-grey-200 px-2 py-1 font-mono text-[12px] text-v2-text-text-base [overflow-wrap:anywhere]"
              >
                {tool}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-v2-text-text-faint">{t("tools.empty")}</p>
        ))}
    </section>
  );
}
