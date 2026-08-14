import { AlertTriangle, CheckCircle2, ExternalLink, KeyRound, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import type { AuthProviderInfoDto } from "../../../web/contracts";
import { type NotifyCard, type PendingPrompt, useProviderAuthFlow } from "../hooks/useProviderAuthFlow";
import { useI18n } from "../i18n/useI18n";

export interface ProviderConnectModalProps {
  onClose: () => void;
}

interface LastRequest {
  providerId: string;
  type: "api_key" | "oauth";
}

function statusDot(configured: boolean): string {
  return configured ? "bg-emerald-500" : "bg-v2-grey-400";
}

export function ProviderConnectModal({ onClose }: ProviderConnectModalProps) {
  const { t } = useI18n();
  const f = useProviderAuthFlow();
  const [methodPickProviderId, setMethodPickProviderId] = useState<string | null>(null);
  const [lastRequest, setLastRequest] = useState<LastRequest | null>(null);

  const begin = (providerId: string, methods: ("api_key" | "oauth")[]) => {
    const type = methods[0] ?? "api_key";
    setLastRequest({ providerId, type });
    if (methods.length === 1) {
      void f.start(providerId, type);
    } else {
      setMethodPickProviderId(providerId);
    }
  };

  const pickMethod = (providerId: string, type: "api_key" | "oauth") => {
    setMethodPickProviderId(null);
    setLastRequest({ providerId, type });
    void f.start(providerId, type);
  };

  const retry = () => {
    if (lastRequest) void f.start(lastRequest.providerId, lastRequest.type);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-v2-grey-1200/30 p-3 sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("providerConnect.title")}
        className="flex max-h-[min(720px,calc(100vh-24px))] w-full max-w-[720px] flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-overlay)]"
      >
        <header className="flex items-center gap-3 border-b border-v2-grey-200 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-semibold text-v2-text-text-base">{t("providerConnect.title")}</h2>
            <p className="mt-0.5 text-[12px] text-v2-text-text-muted">
              {t("settings.connectedCount").replace("{n}", String(f.connectedCount))}
            </p>
          </div>
          <button
            type="button"
            aria-label={t("settings.editor.close")}
            className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-v2-icon-icon-muted hover:bg-v2-grey-100 hover:text-v2-icon-icon-base"
            onClick={onClose}
          >
            <X size={15} aria-hidden />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {f.view === "idle" && (
            <div className="flex flex-col gap-2">
              {f.providers.map((p) => (
                <ProviderRow
                  key={p.id}
                  provider={p}
                  methodPick={methodPickProviderId === p.id}
                  onConnect={() => begin(p.id, p.authMethods)}
                  onPickMethod={(type) => pickMethod(p.id, type)}
                  onDisconnect={() => void f.logout(p.id)}
                />
              ))}
            </div>
          )}

          {f.view === "flow" && (
            <div className="flex flex-col gap-3">
              {f.notifies.map((n, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: notifies are an ordered transient stream with no stable identity.
                <NotifyCardView key={i} notify={n} />
              ))}
              {f.pendingPrompt && <PromptView prompt={f.pendingPrompt} onSubmit={(v) => void f.respond(v)} />}
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  className="text-[12px] text-v2-status-error hover:underline"
                  onClick={() => void f.cancel()}
                >
                  {t("providerConnect.cancel")}
                </button>
                <button
                  type="button"
                  className="text-[12px] text-v2-text-text-muted hover:underline"
                  onClick={f.backToList}
                >
                  {t("providerConnect.back")}
                </button>
              </div>
            </div>
          )}

          {f.view === "done" && (
            <div className="rounded-md border border-emerald-300/40 bg-emerald-50/40 p-3">
              <div className="flex items-center gap-2 text-[13px] font-medium text-emerald-700">
                <CheckCircle2 size={14} aria-hidden />
                {t("providerConnect.done")}
              </div>
              {f.warning && (
                <div className="mt-1.5 flex items-start gap-2 text-[12px] text-v2-status-warning">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
                  {f.warning}
                </div>
              )}
              <button
                type="button"
                className="mt-2 text-[12px] text-v2-blue-600 hover:underline"
                onClick={f.backToList}
              >
                {t("providerConnect.back")}
              </button>
            </div>
          )}

          {f.view === "error" && (
            <div className="rounded-md border border-v2-status-error/30 bg-v2-status-error/5 p-3">
              <div className="flex items-center gap-2 text-[13px] font-medium text-v2-status-error">
                <AlertTriangle size={14} aria-hidden />
                {t("providerConnect.error")}
              </div>
              {f.errorMessage && <p className="mt-1 text-[12px] text-v2-text-text-muted">{f.errorMessage}</p>}
              <div className="mt-2 flex gap-3">
                <button type="button" className="text-[12px] text-v2-blue-600 hover:underline" onClick={retry}>
                  {t("providerConnect.retry")}
                </button>
                <button
                  type="button"
                  className="text-[12px] text-v2-text-text-muted hover:underline"
                  onClick={f.backToList}
                >
                  {t("providerConnect.back")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  methodPick,
  onConnect,
  onPickMethod,
  onDisconnect,
}: {
  provider: AuthProviderInfoDto;
  methodPick: boolean;
  onConnect: () => void;
  onPickMethod: (type: "api_key" | "oauth") => void;
  onDisconnect: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-md border border-v2-grey-200 p-3">
      <div className="flex items-center gap-2">
        <span className={`size-2 shrink-0 rounded-full ${statusDot(provider.authStatus.configured)}`} aria-hidden />
        <span className="min-w-0 truncate text-[13px] font-medium text-v2-text-text-base">{provider.name}</span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {provider.connectable ? (
            provider.authStatus.configured ? (
              <button
                type="button"
                className="rounded-md border border-v2-grey-200 px-2 py-1 text-[12px] text-v2-text-text-base hover:bg-v2-grey-100"
                onClick={onDisconnect}
              >
                {t("providerConnect.disconnect")}
              </button>
            ) : (
              <button
                type="button"
                className="rounded-md bg-v2-grey-1100 px-2 py-1 text-[12px] text-v2-grey-50 hover:bg-v2-grey-900"
                onClick={onConnect}
              >
                {t("providerConnect.connect")}
              </button>
            )
          ) : (
            <span className="text-[11px] text-v2-text-text-faint">{t("providerConnect.ambient")}</span>
          )}
        </div>
      </div>
      {methodPick && (
        <div className="mt-2 flex flex-col gap-1.5 border-t border-v2-grey-200 pt-2">
          <button
            type="button"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-v2-text-text-base hover:bg-v2-grey-100"
            onClick={() => onPickMethod("api_key")}
          >
            <KeyRound size={13} className="text-v2-text-text-muted" aria-hidden />
            {t("providerConnect.method.apiKey")}
          </button>
          <button
            type="button"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-v2-text-text-base hover:bg-v2-grey-100"
            onClick={() => onPickMethod("oauth")}
          >
            <ShieldCheck size={13} className="text-v2-text-text-muted" aria-hidden />
            {t("providerConnect.method.subscription")}
          </button>
        </div>
      )}
      {provider.hint && !provider.connectable && (
        <p className="mt-1.5 text-[12px] text-v2-text-text-muted">{provider.hint}</p>
      )}
    </div>
  );
}

function NotifyCardView({ notify }: { notify: NotifyCard }) {
  const { t } = useI18n();
  if (notify.kind === "auth_url") {
    return (
      <div className="rounded-md border border-v2-grey-200 p-3">
        <p className="text-[12px] text-v2-text-text-muted">{notify.instructions ?? t("providerConnect.authUrl")}</p>
        <a
          href={notify.url}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-flex items-center gap-1 break-all text-[12px] text-v2-blue-600 hover:underline"
        >
          <ExternalLink size={12} aria-hidden />
          {notify.url}
        </a>
      </div>
    );
  }
  if (notify.kind === "device_code") {
    return (
      <div className="rounded-md border border-v2-grey-200 p-3">
        <p className="text-[12px] text-v2-text-text-muted">{t("providerConnect.prompt.deviceCodeAt")}</p>
        <a
          href={notify.verificationUri}
          target="_blank"
          rel="noreferrer"
          className="mt-0.5 inline-flex items-center gap-1 break-all text-[12px] text-v2-blue-600 hover:underline"
        >
          <ExternalLink size={12} aria-hidden />
          {notify.verificationUri}
        </a>
        <div className="mt-2">
          <span className="text-[11px] uppercase tracking-wide text-v2-text-text-faint">
            {t("providerConnect.prompt.deviceCode")}
          </span>
          <div className="font-mono text-[20px] font-bold tracking-[0.2em] text-v2-text-text-base">
            {notify.userCode}
          </div>
        </div>
      </div>
    );
  }
  return <p className="text-[12px] text-v2-text-text-muted">{notify.message}</p>;
}

function PromptView({ prompt, onSubmit }: { prompt: PendingPrompt; onSubmit: (v: string) => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const inputId = "provider-connect-prompt";
  const submit = () => {
    if (value.length === 0) return;
    onSubmit(value);
    setValue("");
  };
  const inputType = prompt.kind === "secret" ? "password" : "text";
  return (
    <div className="rounded-md border border-v2-grey-200 p-3">
      <label htmlFor={inputId} className="block text-[12px] text-v2-text-text-muted">
        {prompt.message}
      </label>
      {prompt.kind === "select" && prompt.options ? (
        <select
          id={inputId}
          className="mt-1.5 h-8 w-full rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 text-[13px] text-v2-text-text-base outline-none focus:border-v2-blue-600"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        >
          <option value="" disabled>
            —
          </option>
          {prompt.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={inputId}
          type={inputType}
          placeholder={prompt.placeholder}
          autoComplete="off"
          className="mt-1.5 h-8 w-full rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 font-mono text-[13px] text-v2-text-text-base outline-none focus:border-v2-blue-600"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      )}
      <button
        type="button"
        className="mt-2 rounded-md bg-v2-grey-1100 px-3 py-1 text-[12px] text-v2-grey-50 disabled:opacity-50"
        disabled={value.length === 0}
        onClick={submit}
      >
        {t("providerConnect.prompt.submit")}
      </button>
    </div>
  );
}
