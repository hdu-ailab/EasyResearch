import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type {
  NetworkProxyScopeDto,
  NetworkProxySettingsDto,
  NetworkProxyTestOutcomeDto,
  NetworkProxyTestResultDto,
  NetworkProxyValuesDto,
} from "../../../../web/contracts";
import { getNetworkProxySettings, patchNetworkProxySettings, testNetworkProxy } from "../../api";
import type { MessageKey } from "../../i18n/messages";
import { useI18n } from "../../i18n/useI18n";

export interface NetworkSettingsPanelProps {
  onDirtyChange(dirty: boolean): void;
  onSavingChange(saving: boolean): void;
  onSavedRestartRequired(): void;
  onOpenConfig?(): void;
}

type Drafts = Record<NetworkProxyScopeDto, string>;
type ProbeState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "result"; result: NetworkProxyTestResultDto }
  | { kind: "request-error" };
type ProbeStates = Record<NetworkProxyScopeDto, ProbeState>;

const scopeRows = [
  {
    id: "all",
    label: "settings.network.all.label",
    description: "settings.network.all.description",
    inheritance: "settings.network.inheritLaunch",
  },
  {
    id: "llm",
    label: "settings.network.llm.label",
    description: "settings.network.llm.description",
    inheritance: "settings.network.inheritAll",
  },
  {
    id: "search",
    label: "settings.network.search.label",
    description: "settings.network.search.description",
    inheritance: "settings.network.inheritAll",
  },
] as const satisfies readonly {
  id: NetworkProxyScopeDto;
  label: MessageKey;
  description: MessageKey;
  inheritance: MessageKey;
}[];

const outcomeKeys: Record<NetworkProxyTestOutcomeDto, MessageKey> = {
  success: "settings.network.outcome.success",
  "invalid-config": "settings.network.outcome.invalidConfig",
  cancelled: "settings.network.outcome.cancelled",
  timeout: "settings.network.outcome.timeout",
  tls: "settings.network.outcome.tls",
  "proxy-connect": "settings.network.outcome.proxyConnect",
  "proxy-response": "settings.network.outcome.proxyResponse",
  "target-response": "settings.network.outcome.targetResponse",
};

function draftsFrom(values: NetworkProxyValuesDto): Drafts {
  return {
    all: values.all ?? "",
    llm: values.llm ?? "",
    search: values.search ?? "",
  };
}

function idleProbes(): ProbeStates {
  return { all: { kind: "idle" }, llm: { kind: "idle" }, search: { kind: "idle" } };
}

function isProxyOrigin(value: string): boolean {
  const candidate = value.trim();
  if (!candidate) return true;
  if (!/^https?:\/\/[^/?#\\]+\/?$/i.test(candidate)) return false;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (!url.hostname || url.username || url.password) return false;
    const authority = candidate.slice(candidate.indexOf("://") + 3).split("/")[0] ?? "";
    if (authority.includes("@")) return false;
    return url.pathname === "/" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function replace(template: string, token: string, value: string): string {
  return template.replace(`{${token}}`, value);
}

function probeText(
  state: Exclude<ProbeState, { kind: "idle" } | { kind: "testing" }>,
  t: (key: MessageKey) => string,
): string {
  if (state.kind === "request-error") return t("settings.network.outcome.requestError");
  const parts = [t(outcomeKeys[state.result.outcome])];
  if (state.result.status !== undefined) {
    parts.push(replace(t("settings.network.httpStatus"), "status", String(state.result.status)));
  }
  parts.push(replace(t("settings.network.elapsed"), "ms", String(state.result.elapsedMs)));
  return parts.join(" · ");
}

export function NetworkSettingsPanel({
  onDirtyChange,
  onSavingChange,
  onSavedRestartRequired,
  onOpenConfig,
}: NetworkSettingsPanelProps) {
  const { t } = useI18n();
  const id = useId();
  const mounted = useRef(true);
  const draftsRef = useRef<Drafts>(draftsFrom({}));
  const probeGenerations = useRef<Record<NetworkProxyScopeDto, number>>({ all: 0, llm: 0, search: 0 });
  const [accepted, setAccepted] = useState<NetworkProxySettingsDto | null>(null);
  const [drafts, setDrafts] = useState<Drafts>(() => draftsFrom({}));
  const [probes, setProbes] = useState<ProbeStates>(idleProbes);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const row of scopeRows) probeGenerations.current[row.id] += 1;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadRevision is the explicit Retry trigger.
  useEffect(() => {
    let current = true;
    setLoading(true);
    setLoadError(false);
    void getNetworkProxySettings().then(
      (next) => {
        if (!current) return;
        const nextDrafts = draftsFrom(next.configured);
        draftsRef.current = nextDrafts;
        setDrafts(nextDrafts);
        setAccepted(next);
        setProbes(idleProbes());
        setSaveError(false);
        setLoading(false);
      },
      () => {
        if (!current) return;
        setLoading(false);
        setLoadError(true);
      },
    );
    return () => {
      current = false;
    };
  }, [loadRevision]);

  const baseline = draftsFrom(accepted?.configured ?? {});
  const dirty = accepted !== null && scopeRows.some(({ id: scope }) => drafts[scope] !== baseline[scope]);
  const hasSettingsError = accepted?.errors.some((error) => error.field === "settings") === true;
  const hasRepairableErrors = accepted?.errors.some((error) => error.field !== "settings") === true;
  const localErrors = Object.fromEntries(
    scopeRows
      .filter(({ id: scope }) => !isProxyOrigin(drafts[scope]))
      .map(({ id: scope }) => [scope, t("settings.network.invalidOrigin")]),
  ) as Partial<Record<NetworkProxyScopeDto, string>>;
  const hasLocalErrors = Object.keys(localErrors).length > 0;
  const canSave =
    accepted !== null && !hasSettingsError && (dirty || hasRepairableErrors) && !saving && !hasLocalErrors;
  const restartBlocked = dirty || hasLocalErrors || saving || (accepted?.errors.length ?? 0) > 0;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const fieldServerError = (scope: NetworkProxyScopeDto): boolean =>
    accepted?.errors.some((error) => error.field === scope) === true && drafts[scope] === baseline[scope];

  const updateDraft = (scope: NetworkProxyScopeDto, value: string) => {
    const next = { ...draftsRef.current, [scope]: value };
    draftsRef.current = next;
    setDrafts(next);
    probeGenerations.current[scope] += 1;
    setProbes((current) => (current[scope].kind === "idle" ? current : { ...current, [scope]: { kind: "idle" } }));
    setSaveError(false);
  };

  const runProbe = async (scope: NetworkProxyScopeDto) => {
    const candidate = draftsRef.current[scope].trim();
    if (!candidate || !isProxyOrigin(candidate)) return;
    const generation = ++probeGenerations.current[scope];
    setProbes((current) => ({ ...current, [scope]: { kind: "testing" } }));
    try {
      const result = await testNetworkProxy({ scope, proxyUrl: candidate });
      if (
        !mounted.current ||
        probeGenerations.current[scope] !== generation ||
        draftsRef.current[scope].trim() !== candidate
      ) {
        return;
      }
      setProbes((current) => ({ ...current, [scope]: { kind: "result", result } }));
    } catch {
      if (
        !mounted.current ||
        probeGenerations.current[scope] !== generation ||
        draftsRef.current[scope].trim() !== candidate
      ) {
        return;
      }
      setProbes((current) => ({ ...current, [scope]: { kind: "request-error" } }));
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    const pending = draftsRef.current;
    const payload = {
      all: pending.all.trim() || null,
      llm: pending.llm.trim() || null,
      search: pending.search.trim() || null,
    };
    setSaving(true);
    onSavingChange(true);
    setSaveError(false);
    try {
      const next = await patchNetworkProxySettings(payload);
      if (!mounted.current) return;
      const nextDrafts = draftsFrom(next.configured);
      draftsRef.current = nextDrafts;
      setDrafts(nextDrafts);
      setAccepted(next);
      for (const row of scopeRows) probeGenerations.current[row.id] += 1;
      setProbes(idleProbes());
      setSaving(false);
      onSavingChange(false);
      if (next.restartRequired) onSavedRestartRequired();
    } catch {
      if (!mounted.current) return;
      setSaving(false);
      onSavingChange(false);
      setSaveError(true);
    }
  };

  return (
    <form className="flex w-full flex-col gap-4" aria-label={t("settings.network.title")} onSubmit={save}>
      <h2
        tabIndex={-1}
        data-settings-panel-heading
        className="text-[15px] font-semibold text-v2-text-text-base outline-none"
      >
        {t("settings.network.title")}
      </h2>

      {loading ? (
        <p className="text-[13px] text-v2-text-text-muted" role="status">
          {t("settings.network.loading")}
        </p>
      ) : loadError ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-v2-status-error/30 bg-v2-status-error/5 px-3 py-2 text-[13px] text-v2-status-error"
          role="alert"
        >
          <span>{t("settings.network.loadError")}</span>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 font-medium underline underline-offset-2 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600"
            onClick={() => setLoadRevision((current) => current + 1)}
          >
            {t("settings.network.retry")}
          </button>
        </div>
      ) : (
        <>
          <section
            className="overflow-hidden rounded-[10px] border border-v2-grey-200 bg-v2-background-bg-base"
            aria-label={t("settings.network.title")}
          >
            {scopeRows.map((row, index) => {
              const inputId = `${id}-${row.id}`;
              const descriptionId = `${inputId}-description`;
              const inheritanceId = `${inputId}-inheritance`;
              const errorId = `${inputId}-error`;
              const probeId = `${inputId}-probe`;
              const localError = localErrors[row.id];
              const storedInvalid = fieldServerError(row.id);
              const invalid = localError !== undefined || storedInvalid;
              const probe = probes[row.id];
              const canTest =
                !saving && drafts[row.id].trim().length > 0 && localError === undefined && probe.kind !== "testing";
              const describedBy = [
                descriptionId,
                inheritanceId,
                ...(invalid ? [errorId] : []),
                ...(probe.kind !== "idle" ? [probeId] : []),
              ].join(" ");
              const label = t(row.label);
              return (
                <div
                  key={row.id}
                  className={`flex flex-col gap-2 px-4 py-4 ${index === 0 ? "" : "border-t border-v2-grey-200"}`}
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <label
                      htmlFor={inputId}
                      className="min-w-0 flex-1 text-[13px] font-semibold text-v2-text-text-base"
                    >
                      {label}
                    </label>
                    <button
                      type="button"
                      aria-label={replace(t("settings.network.testField"), "field", label)}
                      disabled={!canTest}
                      className="h-8 shrink-0 rounded-md border border-v2-grey-200 px-3 text-[12px] font-medium text-v2-text-text-base transition-colors hover:bg-v2-grey-100 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600 disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={() => void runProbe(row.id)}
                    >
                      {t("settings.network.test")}
                    </button>
                  </div>
                  <p id={descriptionId} className="text-[12px] leading-relaxed text-v2-text-text-muted">
                    {t(row.description)}
                  </p>
                  <input
                    id={inputId}
                    type="text"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={drafts[row.id]}
                    disabled={saving}
                    aria-invalid={invalid || undefined}
                    aria-describedby={describedBy}
                    placeholder="http://proxy.example:8080"
                    className="h-9 w-full rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-3 font-mono text-[12px] text-v2-text-text-base outline-none transition-colors placeholder:text-v2-text-text-faint focus:border-v2-blue-600 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600 disabled:opacity-60"
                    onChange={(event) => updateDraft(row.id, event.target.value)}
                  />
                  <p id={inheritanceId} className="text-[11px] text-v2-text-text-faint">
                    {t(row.inheritance)}
                  </p>
                  {invalid && (
                    <p id={errorId} className="text-[12px] text-v2-status-error" role="alert">
                      {localError ?? replace(t("settings.network.storedInvalid"), "field", label)}
                    </p>
                  )}
                  {probe.kind === "testing" && (
                    <p id={probeId} className="text-[12px] text-v2-text-text-muted" role="status">
                      {t("settings.network.testing")}
                    </p>
                  )}
                  {(probe.kind === "result" || probe.kind === "request-error") && (
                    <p
                      id={probeId}
                      className={`text-[12px] ${
                        probe.kind === "result" && probe.result.ok ? "text-v2-status-success" : "text-v2-status-warning"
                      }`}
                      role="status"
                    >
                      {probeText(probe, t)}
                    </p>
                  )}
                </div>
              );
            })}
          </section>

          {hasSettingsError && (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-v2-status-error/30 bg-v2-status-error/5 px-3 py-2 text-[12px] text-v2-status-error"
              role="alert"
            >
              <span>{t("settings.network.settingsInvalid")}</span>
              {onOpenConfig && (
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 font-medium underline underline-offset-2 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600"
                  onClick={onOpenConfig}
                >
                  {t("settings.config.entry")}
                </button>
              )}
            </div>
          )}
          {saveError && (
            <p
              className="rounded-md border border-v2-status-error/30 bg-v2-status-error/5 px-3 py-2 text-[12px] text-v2-status-error"
              role="alert"
            >
              {t("settings.network.saveError")}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {accepted?.restartRequired && (
              <button
                type="button"
                disabled={restartBlocked}
                className="h-9 rounded-md border border-v2-status-warning/40 bg-v2-status-warning/5 px-3 text-[12px] font-medium text-v2-status-warning transition-colors hover:bg-v2-status-warning/10 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={onSavedRestartRequired}
              >
                {t("settings.network.restartRequired")}
              </button>
            )}
            <button
              type="submit"
              aria-label={t("settings.network.saveAction")}
              disabled={!canSave}
              className="h-9 rounded-md bg-v2-blue-600 px-4 text-[12px] font-medium text-v2-grey-50 transition-colors hover:bg-v2-blue-700 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? t("settings.network.saving") : t("settings.network.save")}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
