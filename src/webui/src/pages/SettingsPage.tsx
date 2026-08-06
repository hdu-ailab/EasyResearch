import { useCallback, useEffect, useState } from "react";
import { Activity, FileJson, Settings2 } from "lucide-react";
import type { AgentDto, WebuiSettingsDto } from "../../../web/contracts";
import { getWebuiSettings, listAgents, listModels, updateWebuiSettings } from "../api";
import { applyWebuiSettings } from "../webui-fonts";
import { BackButton, ProductMark, Topbar } from "../components/Topbar";

export interface SettingsPageProps {
  onBack: () => void;
  onOpenConfigPage: () => void;
}

const CHAT_SIZES = [11, 12, 13, 14, 15, 16, 17, 18];
const FILES_SIZES = [10, 11, 12, 13, 14, 15, 16];

const sectionClass =
  "rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] focus-within:border-v2-grey-200";

/**
 * Homepage settings page: live Web panel font sizes, per-agent global model
 * overrides, and an entry into the per-scope settings.json editor.
 */
export function SettingsPage({ onBack, onOpenConfigPage }: SettingsPageProps) {
  const [settings, setSettings] = useState<WebuiSettingsDto | null>(null);
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [models, setModels] = useState<Array<{ provider: string; id: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([getWebuiSettings(), listAgents(), listModels()])
      .then(([s, a, m]) => {
        setSettings(s);
        applyWebuiSettings(s);
        setAgents(a);
        setModels(m);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const patch = useCallback(async (partial: Parameters<typeof updateWebuiSettings>[0]) => {
    if (!settings) return;
    setBusy(true);
    setError(null);
    const previous = settings;
    try {
      const updated = await updateWebuiSettings(partial);
      setSettings(updated);
      applyWebuiSettings(updated);
    } catch (e) {
      setSettings(previous);
      applyWebuiSettings(previous);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [settings]);

  const setAgentModel = (name: string, value: string) => {
    if (!settings) return;
    const agentModels = { ...settings.agentModels };
    if (value === "") delete agentModels[name];
    else agentModels[name] = value;
    void patch({ agentModels });
  };

  const setOrchestratorModel = (value: string) => {
    void patch({ orchestratorModel: value === "" ? null : value });
  };

  const disabled = !settings || busy;

  return (
    <div className="flex h-full flex-col">
      <Topbar
        leading={
          <>
            <BackButton onClick={onBack} />
            <ProductMark />
          </>
        }
        center={<span className="truncate text-[13px] text-v2-text-text-muted">Settings</span>}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
          <section className={sectionClass} aria-label="Appearance">
            <header className="flex items-center gap-2 border-b border-v2-grey-200 px-4 py-2.5">
              <Activity size={14} className="text-v2-icon-icon-muted" aria-hidden />
              <h2 className="text-[13px] font-semibold text-v2-text-text-base">Appearance</h2>
            </header>
            <div className="flex flex-col gap-3 px-4 py-4">
              <label className="flex items-center justify-between gap-4">
                <span className="text-[13px] text-v2-text-text-base">Chat font size</span>
                <select
                  className="h-8 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 text-[13px] text-v2-text-text-base outline-none focus:border-v2-blue-600 disabled:opacity-50"
                  aria-label="Chat font size"
                  value={settings?.chatFontSize ?? 13}
                  onChange={(e) => void patch({ chatFontSize: Number(e.target.value) })}
                  disabled={disabled}
                >
                  {CHAT_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size}px
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center justify-between gap-4">
                <span className="text-[13px] text-v2-text-text-base">Files font size</span>
                <select
                  className="h-8 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 text-[13px] text-v2-text-text-base outline-none focus:border-v2-blue-600 disabled:opacity-50"
                  aria-label="Files font size"
                  value={settings?.filesFontSize ?? 12}
                  onChange={(e) => void patch({ filesFontSize: Number(e.target.value) })}
                  disabled={disabled}
                >
                  {FILES_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size}px
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          <section className={sectionClass} aria-label="Agent models">
            <header className="flex items-center gap-2 border-b border-v2-grey-200 px-4 py-2.5">
              <Settings2 size={14} className="text-v2-icon-icon-muted" aria-hidden />
              <h2 className="text-[13px] font-semibold text-v2-text-text-base">Agent models</h2>
              <span className="ml-auto text-[12px] text-v2-text-text-faint">
                Global defaults — project overrides are set in the JSON editor
              </span>
            </header>
            <div className="flex flex-col gap-3 px-4 py-4">
              {agents.map((agent) =>
                agent.name === "orchestrator" ? (
                  <div key={agent.name}>
                    <label className="flex items-center justify-between gap-4">
                      <span className="flex flex-col">
                        <span className="text-[13px] font-medium text-v2-text-text-base">orchestrator</span>
                        <span className="text-[12px] text-v2-text-text-muted">Pi's global default model</span>
                      </span>
                      <select
                        className="h-8 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 text-[13px] text-v2-text-text-base outline-none focus:border-v2-blue-600 disabled:opacity-50"
                        aria-label="orchestrator model"
                        value={settings?.orchestratorModel ?? ""}
                        onChange={(e) => setOrchestratorModel(e.target.value)}
                        disabled={disabled}
                      >
                        <option value=""> </option>
                        {models.map((m) => (
                          <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                            {m.provider}/{m.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    {settings && !settings.orchestratorModel && settings.effectiveOrchestratorModel && (
                      <p className="mt-1 text-right text-[12px] text-v2-text-text-muted">
                        Pi will use: {settings.effectiveOrchestratorModel}
                      </p>
                    )}
                  </div>
                ) : (
                  <label key={agent.name} className="flex items-center justify-between gap-4">
                    <span className="text-[13px] font-medium text-v2-text-text-base">{agent.name}</span>
                    <select
                      className="h-8 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 text-[13px] text-v2-text-text-base outline-none focus:border-v2-blue-600 disabled:opacity-50"
                      aria-label={`${agent.name} model`}
                      value={settings?.agentModels[agent.name] ?? ""}
                      onChange={(e) => setAgentModel(agent.name, e.target.value)}
                      disabled={disabled}
                    >
                      <option value="">inherit (orchestrator's model)</option>
                      {models.map((m) => (
                        <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                          {m.provider}/{m.id}
                        </option>
                      ))}
                    </select>
                  </label>
                ),
              )}
            </div>
          </section>

          <section className={sectionClass} aria-label="Edit JSON config file">
            <button
              type="button"
              className="flex h-9 w-full items-center gap-2 rounded-[10px] px-4 py-2 text-[13px] font-medium text-v2-text-text-base transition-colors hover:bg-v2-grey-100 disabled:opacity-50"
              onClick={onOpenConfigPage}
              disabled={disabled}
            >
              <FileJson size={14} className="text-v2-text-text-muted" aria-hidden />
              Edit JSON config file…
            </button>
          </section>

          {error && (
            <p className="rounded-md border border-v2-status-error/30 bg-v2-status-error/5 px-3 py-2 text-[13px] text-v2-status-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}