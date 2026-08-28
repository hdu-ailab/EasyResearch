import { AlertTriangle, CheckCircle2, ExternalLink, KeyRound, Search, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthProviderInfoDto } from "../../../web/contracts";
import { useModalLayer } from "../hooks/useModalLayer";
import {
  type NotifyCard,
  type PendingPrompt,
  type UseProviderAuthFlow,
  useProviderAuthFlow,
} from "../hooks/useProviderAuthFlow";
import { useI18n } from "../i18n/useI18n";
import { ProviderIcon } from "./ProviderIcon";

export interface ProviderConnectModalProps {
  onClose: () => void;
}

export interface ProviderConnectModalContentProps extends ProviderConnectModalProps {
  flow: UseProviderAuthFlow;
}

function statusDot(configured: boolean): string {
  return configured ? "bg-emerald-500" : "bg-v2-grey-400";
}

export function ProviderConnectModal({ onClose }: ProviderConnectModalProps) {
  const flow = useProviderAuthFlow();
  return <ProviderConnectModalContent flow={flow} onClose={onClose} />;
}

export function ProviderConnectModalContent({ onClose, flow: f }: ProviderConnectModalContentProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const { zIndex, dialogProps } = useModalLayer(onClose, dialogRef);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [deleteConfirmation, setDeleteConfirmation] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const selected = selectedId ? (f.providers.find((p) => p.id === selectedId) ?? null) : null;

  useEffect(() => {
    if (f.view === "idle" && !selected) searchRef.current?.focus();
  }, [f.view, selected]);

  // Leaving flow (abort/error/done/back) clears the selected provider so the
  // list is the resting view.
  useEffect(() => {
    if (f.view !== "flow" && f.view !== "idle") return;
    if (f.view === "idle") setSelectedId(null);
  }, [f.view]);

  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return f.providers;
    return f.providers.filter((p) => `${p.id} ${p.name}`.toLowerCase().includes(query));
  }, [f.providers, filter]);

  const openProvider = (provider: AuthProviderInfoDto) => {
    setSelectedId(provider.id);
    setDeleteConfirmation(null);
    setActionError(null);
    if (
      provider.connectable &&
      !provider.authStatus.configured &&
      provider.authMethods.length === 1 &&
      provider.authMethods[0]
    ) {
      void f.start(provider.id, provider.authMethods[0]);
    }
  };

  const disconnectProvider = async (providerId: string) => {
    setActionBusy(true);
    setActionError(null);
    try {
      await f.logout(providerId);
      setSelectedId(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionBusy(false);
    }
  };

  const removeProvider = async (providerId: string) => {
    if (deleteConfirmation !== providerId) {
      setDeleteConfirmation(providerId);
      return;
    }
    setActionBusy(true);
    setActionError(null);
    try {
      await f.deleteProvider(providerId);
      setSelectedId(null);
      setDeleteConfirmation(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionBusy(false);
    }
  };

  const pickMethod = (providerId: string, type: "api_key" | "oauth") => {
    void f.start(providerId, type);
  };

  const retry = () => {
    if (selected) openProvider(selected);
  };

  const move = (direction: 1 | -1) => {
    if (filtered.length === 0) return;
    const index = filtered.findIndex((p) => p.id === activeId);
    const next =
      index < 0 ? (direction > 0 ? 0 : filtered.length - 1) : (index + direction + filtered.length) % filtered.length;
    const target = filtered[next];
    if (!target) return;
    setActiveId(target.id);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-provider-id="${CSS.escape(target.id)}"]`)
      ?.focus({ preventScroll: true });
  };

  const handleListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const target = event.key === "Home" ? filtered[0] : filtered.at(-1);
      if (!target) return;
      setActiveId(target.id);
      listRef.current
        ?.querySelector<HTMLElement>(`[data-provider-id="${CSS.escape(target.id)}"]`)
        ?.focus({ preventScroll: true });
      return;
    }
    if (event.key !== "Enter" || !activeId) return;
    const provider = filtered.find((p) => p.id === activeId);
    if (provider) openProvider(provider);
    event.preventDefault();
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/30 p-0 min-[820px]:p-6"
      style={{ zIndex }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        {...dialogProps}
        aria-label={t("providerConnect.title")}
        className="flex h-full w-full flex-col overflow-hidden bg-v2-background-bg-base shadow-[var(--v2-elevation-overlay)] min-[820px]:h-auto min-[820px]:max-h-[min(720px,calc(100vh-24px))] min-[820px]:max-w-[720px] min-[820px]:rounded-[10px]"
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
          {f.view === "idle" && !selected && (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="relative shrink-0">
                <Search
                  size={14}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-v2-text-text-muted"
                  aria-hidden
                />
                <input
                  ref={searchRef}
                  type="search"
                  aria-label={t("providerConnect.search")}
                  placeholder={t("providerConnect.search")}
                  className="h-8 w-full rounded-md border border-v2-grey-200 bg-v2-background-bg-base pl-8 pr-2 text-[13px] text-v2-text-text-base outline-none focus:border-v2-blue-600"
                  value={filter}
                  onChange={(event) => {
                    setFilter(event.target.value);
                    setActiveId(undefined);
                  }}
                  onKeyDown={handleListKeyDown}
                />
              </div>
              <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
                {f.providersError && (
                  <div className="mb-2 flex items-center justify-between gap-3 rounded-md border border-v2-status-error/30 px-3 py-2">
                    <p role="alert" className="text-[12px] text-v2-status-error">
                      {f.providersError}
                    </p>
                    <button
                      type="button"
                      className="shrink-0 text-[12px] text-v2-blue-600 hover:underline"
                      onClick={() => void f.refresh()}
                    >
                      {t("providerConnect.retry")}
                    </button>
                  </div>
                )}
                {filtered.map((p) => (
                  <ProviderRow
                    key={p.id}
                    provider={p}
                    active={activeId === p.id}
                    onActivate={() => setActiveId(p.id)}
                    onOpen={() => openProvider(p)}
                    onKeyDown={handleListKeyDown}
                  />
                ))}
                {filtered.length === 0 && (
                  <p className="px-3 py-4 text-center text-[12px] text-v2-text-text-muted">
                    {t("providerConnect.noResults")}
                  </p>
                )}
              </div>
            </div>
          )}

          {f.view === "idle" && selected && (
            <ConnectionView
              provider={selected}
              onPickMethod={(type) => pickMethod(selected.id, type)}
              onDisconnect={() => void disconnectProvider(selected.id)}
              onDelete={() => void removeProvider(selected.id)}
              deleteConfirmation={deleteConfirmation === selected.id}
              actionError={actionError}
              busy={actionBusy}
              onBack={() => {
                setSelectedId(null);
                setDeleteConfirmation(null);
                setActionError(null);
              }}
            />
          )}

          {f.view === "flow" && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <ProviderIcon
                  id={f.activeProviderId ?? "synthetic"}
                  className="size-6 shrink-0 text-v2-icon-icon-base"
                />
                <div className="min-w-0">
                  <h3 className="truncate text-[14px] font-semibold text-v2-text-text-base">
                    {f.activeProviderId
                      ? (f.providers.find((p) => p.id === f.activeProviderId)?.name ?? f.activeProviderId)
                      : ""}
                  </h3>
                </div>
              </div>
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
              </div>
            </div>
          )}

          {f.view === "done" && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[13px] font-medium text-emerald-700">
                <CheckCircle2 size={14} aria-hidden />
                {t("providerConnect.done")}
              </div>
              {f.warning && (
                <div className="flex items-start gap-2 text-[12px] text-v2-status-warning">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
                  {f.warning}
                </div>
              )}
              <button
                type="button"
                className="mt-1 w-fit text-[12px] text-v2-blue-600 hover:underline"
                onClick={f.backToList}
              >
                {t("providerConnect.back")}
              </button>
            </div>
          )}

          {f.view === "error" && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[13px] font-medium text-v2-status-error">
                <AlertTriangle size={14} aria-hidden />
                {t("providerConnect.error")}
              </div>
              {f.errorMessage && <p className="text-[12px] text-v2-text-text-muted">{f.errorMessage}</p>}
              <div className="mt-1 flex gap-3">
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
  active,
  onActivate,
  onOpen,
  onKeyDown,
}: {
  provider: AuthProviderInfoDto;
  active: boolean;
  onActivate: () => void;
  onOpen: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      data-provider-id={provider.id}
      onMouseEnter={onActivate}
      onFocus={onActivate}
      onKeyDown={onKeyDown}
      onClick={onOpen}
      className={`flex min-h-9 w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] leading-none tracking-[-0.04px] transition-colors ${
        active ? "bg-v2-grey-100" : "hover:bg-v2-grey-100"
      }`}
    >
      <ProviderIcon id={provider.id} className="size-4 shrink-0 text-v2-icon-icon-base" />
      <span className="min-w-0 truncate font-medium text-v2-text-text-base">{provider.name}</span>
      <span className={`size-1.5 shrink-0 rounded-full ${statusDot(provider.authStatus.configured)}`} aria-hidden />
      {!provider.connectable && (
        <span className="ml-auto shrink-0 text-[11px] text-v2-text-text-faint">{t("providerConnect.ambient")}</span>
      )}
    </button>
  );
}

function ConnectionView({
  provider,
  onPickMethod,
  onDisconnect,
  onDelete,
  deleteConfirmation,
  actionError,
  busy,
  onBack,
}: {
  provider: AuthProviderInfoDto;
  onPickMethod: (type: "api_key" | "oauth") => void;
  onDisconnect: () => void;
  onDelete: () => void;
  deleteConfirmation: boolean;
  actionError: string | null;
  busy: boolean;
  onBack: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-center gap-3">
        <ProviderIcon id={provider.id} className="size-6 shrink-0 text-v2-icon-icon-base" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[14px] font-semibold text-v2-text-text-base">{provider.name}</h3>
            <span className={`size-2 shrink-0 rounded-full ${statusDot(provider.authStatus.configured)}`} aria-hidden />
          </div>
          {provider.hint && !provider.connectable && (
            <p className="mt-0.5 text-[12px] text-v2-text-text-muted">{provider.hint}</p>
          )}
        </div>
      </div>

      {provider.connectable ? (
        <div className="flex flex-col gap-2">
          <div className="px-1 text-[13px] text-v2-text-text-muted">
            {t("providerConnect.selectMethod").replace("{provider}", provider.name)}
          </div>
          {provider.authMethods.map((method) => (
            <button
              key={method}
              type="button"
              className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-[13px] text-v2-text-text-base transition-colors hover:bg-v2-grey-100"
              onClick={() => onPickMethod(method)}
            >
              {method === "api_key" ? (
                <KeyRound size={14} className="shrink-0 text-v2-text-text-muted" aria-hidden />
              ) : (
                <ShieldCheck size={14} className="shrink-0 text-v2-text-text-muted" aria-hidden />
              )}
              {method === "api_key" ? t("providerConnect.method.apiKey") : t("providerConnect.method.subscription")}
            </button>
          ))}
        </div>
      ) : (
        <p className="px-1 text-[12px] text-v2-text-text-muted">
          {t("providerConnect.ambientLong").replace("{provider}", provider.name)}
        </p>
      )}

      <div className="mt-auto flex flex-col items-start gap-2">
        {provider.authStatus.configured && !provider.noAuth && (
          <button
            type="button"
            disabled={busy}
            className="w-fit text-[12px] text-v2-status-error hover:underline disabled:opacity-50"
            onClick={onDisconnect}
          >
            {t("providerConnect.disconnectProvider").replace("{provider}", provider.name)}
          </button>
        )}
        {provider.modelsJson && (
          <button
            type="button"
            disabled={busy}
            className="w-fit text-[12px] text-v2-status-error hover:underline disabled:opacity-50"
            onClick={onDelete}
          >
            {deleteConfirmation
              ? t("providerConnect.confirmDeleteProvider").replace("{provider}", provider.name)
              : t("providerConnect.deleteProvider").replace("{provider}", provider.name)}
          </button>
        )}
        {actionError && (
          <p role="alert" className="text-[12px] text-v2-status-error">
            {actionError}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-v2-grey-200 pt-3">
        <button type="button" className="text-[12px] text-v2-text-text-muted hover:underline" onClick={onBack}>
          {t("providerConnect.back")}
        </button>
      </div>
    </div>
  );
}

function NotifyCardView({ notify }: { notify: NotifyCard }) {
  const { t } = useI18n();
  if (notify.kind === "info") {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-[13px] text-v2-text-text-muted">{notify.message}</p>
        {notify.links && notify.links.length > 0 && (
          <div className="flex flex-col gap-1">
            {notify.links.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 break-all text-[13px] text-v2-blue-600 hover:underline"
              >
                <ExternalLink size={13} aria-hidden />
                {link.label ?? link.url}
              </a>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (notify.kind === "auth_url") {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-[13px] text-v2-text-text-muted">{notify.instructions ?? t("providerConnect.authUrl")}</p>
        <a
          href={notify.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 break-all text-[13px] text-v2-blue-600 hover:underline"
        >
          <ExternalLink size={13} aria-hidden />
          {notify.url}
        </a>
      </div>
    );
  }
  if (notify.kind === "device_code") {
    return <DeviceCodeView notify={notify} />;
  }
  return <p className="text-[13px] text-v2-text-text-muted">{notify.message}</p>;
}

function DeviceCodeView({ notify }: { notify: Extract<NotifyCard, { kind: "device_code" }> }) {
  const { t } = useI18n();
  const [remaining, setRemaining] = useState(notify.expiresInSeconds ?? 0);
  useEffect(() => {
    if (!notify.expiresInSeconds) return;
    setRemaining(notify.expiresInSeconds);
    const timer = setInterval(() => setRemaining((current) => Math.max(0, current - 1)), 1000);
    return () => clearInterval(timer);
  }, [notify.expiresInSeconds]);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] text-v2-text-text-muted">{t("providerConnect.prompt.deviceCodeAt")}</p>
      <a
        href={notify.verificationUri}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 break-all text-[13px] text-v2-blue-600 hover:underline"
      >
        <ExternalLink size={13} aria-hidden />
        {notify.verificationUri}
      </a>
      <div className="mt-1 flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wide text-v2-text-text-faint">
          {t("providerConnect.prompt.deviceCode")}
        </span>
        <div className="font-mono text-[22px] font-bold tracking-[0.2em] text-v2-text-text-base">{notify.userCode}</div>
        {notify.expiresInSeconds !== undefined && (
          <div className="text-[11px] tabular-nums text-v2-text-text-muted" aria-live="polite">
            {t("providerConnect.prompt.expiresIn").replace("{s}", String(remaining))}
          </div>
        )}
      </div>
    </div>
  );
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
  const inputClass =
    "h-9 w-full rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-3 text-[13px] text-v2-text-text-base outline-none focus:border-v2-blue-600";
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={inputId} className="text-[13px] text-v2-text-text-muted">
        {prompt.message}
      </label>
      {prompt.kind === "select" && prompt.options ? (
        <select id={inputId} className={inputClass} value={value} onChange={(e) => setValue(e.target.value)}>
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
          className={`${inputClass} font-mono`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      )}
      <button
        type="button"
        className="mt-1 w-fit rounded-md bg-v2-grey-1100 px-3 py-1.5 text-[12px] text-v2-grey-50 disabled:opacity-50"
        disabled={value.length === 0}
        onClick={submit}
      >
        {t("providerConnect.prompt.submit")}
      </button>
    </div>
  );
}
