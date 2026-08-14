import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthFlowEventDto, AuthProviderInfoDto } from "../../../web/contracts";
import {
  authFlowEventSource,
  cancelAuthFlow,
  listAuthProviders,
  logoutProvider,
  respondAuthFlow,
  startAuthFlow,
} from "../api";

export type FlowView = "idle" | "flow" | "done" | "error";

export interface PendingPrompt {
  kind: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

export type NotifyCard =
  | {
      kind: "info";
      message: string;
      links?: { url: string; label?: string }[];
    }
  | {
      kind: "auth_url";
      url: string;
      instructions?: string;
    }
  | {
      kind: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | {
      kind: "progress";
      message: string;
    };

export interface UseProviderAuthFlow {
  providers: AuthProviderInfoDto[];
  connectedCount: number;
  view: FlowView;
  pendingPrompt: PendingPrompt | null;
  notifies: NotifyCard[];
  warning?: string;
  errorMessage?: string;
  errorReason?: "aborted" | "timeout" | "reject";
  activeProviderId?: string;
  start(providerId: string, type: "api_key" | "oauth"): Promise<void>;
  respond(value: string): Promise<void>;
  cancel(): Promise<void>;
  backToList(): void;
  logout(providerId: string): Promise<void>;
  refresh(): Promise<void>;
}

/** A provider is "already configured" when auth is set up OR it is a custom
 * `models.json`-declared provider; those are pinned above the rest. */
function isPinned(provider: AuthProviderInfoDto): boolean {
  return provider.authStatus?.configured === true || provider.modelsJson === true;
}

function sortProviders(providers: AuthProviderInfoDto[]): AuthProviderInfoDto[] {
  return [...providers].sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)));
}

export function useProviderAuthFlow(): UseProviderAuthFlow {
  const [providers, setProviders] = useState<AuthProviderInfoDto[]>([]);
  const [view, setView] = useState<FlowView>("idle");
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null);
  const [notifies, setNotifies] = useState<NotifyCard[]>([]);
  const [warning, setWarning] = useState<string | undefined>();
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [errorReason, setErrorReason] = useState<"aborted" | "timeout" | "reject" | undefined>();
  const [activeProviderId, setActiveProviderId] = useState<string | undefined>();
  const genRef = useRef(0);
  const unsubRef = useRef<(() => void) | null>(null);
  const flowIdRef = useRef<string | null>(null);
  const terminalRef = useRef(false);
  const errorStreakRef = useRef(0);

  const refresh = useCallback(async () => {
    setProviders(sortProviders(await listAuthProviders()));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const closeStream = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
  }, []);

  // Unmount cleanup: close the SSE stream and cancel any server-side flow so
  // the single-flight lock is not held after the modal goes away.
  useEffect(() => {
    return () => {
      closeStream();
      const flowId = flowIdRef.current;
      flowIdRef.current = null;
      if (flowId) void cancelAuthFlow(flowId).catch(() => {});
    };
  }, [closeStream]);

  const start = useCallback(
    async (providerId: string, type: "api_key" | "oauth") => {
      closeStream();
      terminalRef.current = false;
      errorStreakRef.current = 0;
      setView("flow");
      setPendingPrompt(null);
      setNotifies([]);
      setWarning(undefined);
      setErrorMessage(undefined);
      setErrorReason(undefined);
      setActiveProviderId(providerId);
      let flowId: string;
      try {
        ({ flowId } = await startAuthFlow({ providerId, type }));
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setErrorReason("reject");
        setView("error");
        return;
      }
      flowIdRef.current = flowId;
      const gen = ++genRef.current;
      const onEvent = (event: AuthFlowEventDto) => {
        if (genRef.current !== gen) return;
        errorStreakRef.current = 0;
        if (event.type === "prompt") {
          setPendingPrompt({
            kind: event.kind,
            message: event.message,
            placeholder: event.placeholder,
            options: event.options,
          });
        } else if (event.type === "notify") {
          setNotifies((prev) => {
            if (event.event.kind === "progress") {
              // Transient status line: the newest progress replaces any prior one.
              const rest = prev.filter((n) => n.kind !== "progress");
              return [...rest, event.event];
            }
            return [...prev, event.event];
          });
        } else if (event.type === "done") {
          terminalRef.current = true;
          setPendingPrompt(null);
          setWarning(event.warning);
          setView("done");
          closeStream();
          void refresh();
        } else if (event.type === "error") {
          terminalRef.current = true;
          setPendingPrompt(null);
          setErrorMessage(event.message);
          setErrorReason(event.reason);
          setView("error");
          closeStream();
        }
      };
      unsubRef.current = authFlowEventSource(flowId, {
        onEvent,
        onError: () => {
          if (genRef.current !== gen) return;
          if (terminalRef.current) return;
          // Transient network blip: the server replays the pending prompt and
          // any buffered events on reconnect, so drop the notifies client-side
          // to avoid duplicate cards. The pending prompt is kept (it is
          // replayed identically) so a typed secret is not blanked.
          errorStreakRef.current += 1;
          if (errorStreakRef.current >= 3) {
            setErrorMessage("Connection lost");
            setErrorReason(undefined);
            setView("error");
          } else {
            setNotifies([]);
          }
        },
      });
    },
    [closeStream, refresh],
  );

  const respond = useCallback(async (value: string) => {
    if (!flowIdRef.current) return;
    await respondAuthFlow(flowIdRef.current, value);
  }, []);

  const cancel = useCallback(async () => {
    const flowId = flowIdRef.current;
    if (!flowId) return;
    try {
      await cancelAuthFlow(flowId);
    } catch {
      // The flow may already have terminated server-side; the SSE terminal
      // event (or the error card) is the source of truth.
    }
  }, []);

  const backToList = useCallback(() => {
    // An active flow must be cancelled server-side or the single-flight lock
    // stays held and the next Connect request gets a 409.
    const flowId = flowIdRef.current;
    if (flowId) void cancelAuthFlow(flowId).catch(() => {});
    closeStream();
    flowIdRef.current = null;
    terminalRef.current = false;
    errorStreakRef.current = 0;
    setView("idle");
    setPendingPrompt(null);
    setNotifies([]);
    setWarning(undefined);
    setErrorMessage(undefined);
    setErrorReason(undefined);
    setActiveProviderId(undefined);
    void refresh();
  }, [closeStream, refresh]);

  const logout = useCallback(
    async (providerId: string) => {
      await logoutProvider(providerId);
      void refresh();
    },
    [refresh],
  );

  const connectedCount = useMemo(() => providers.filter((p) => p.authStatus?.configured).length, [providers]);

  return {
    providers,
    connectedCount,
    view,
    pendingPrompt,
    notifies,
    warning,
    errorMessage,
    errorReason,
    activeProviderId,
    start,
    respond,
    cancel,
    backToList,
    logout,
    refresh,
  };
}
