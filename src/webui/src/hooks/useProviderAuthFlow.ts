import { useCallback, useEffect, useRef, useState } from "react";
import {
  authFlowEventSource,
  cancelAuthFlow,
  listAuthProviders,
  logoutProvider,
  respondAuthFlow,
  startAuthFlow,
} from "../api";
import type { AuthFlowEventDto, AuthProviderInfoDto } from "../../../web/contracts";

export type FlowView = "idle" | "flow" | "done" | "error";

export interface PendingPrompt {
  kind: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

export type NotifyCard = {
  kind: "info";
  message: string;
  links?: { url: string; label?: string }[];
} | {
  kind: "auth_url";
  url: string;
  instructions?: string;
} | {
  kind: "device_code";
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
} | {
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

  const refresh = useCallback(async () => {
    setProviders(await listAuthProviders());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const closeStream = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
  }, []);

  const start = useCallback(
    async (providerId: string, type: "api_key" | "oauth") => {
      closeStream();
      setView("flow");
      setPendingPrompt(null);
      setNotifies([]);
      setWarning(undefined);
      setErrorMessage(undefined);
      setErrorReason(undefined);
      setActiveProviderId(providerId);
      const { flowId } = await startAuthFlow({ providerId, type });
      flowIdRef.current = flowId;
      const gen = ++genRef.current;
      const onEvent = (event: AuthFlowEventDto) => {
        if (genRef.current !== gen) return;
        if (event.type === "prompt") {
          setPendingPrompt({
            kind: event.kind,
            message: event.message,
            placeholder: event.placeholder,
            options: event.options,
          });
        } else if (event.type === "notify") {
          setNotifies((prev) => [...prev, event.event]);
        } else if (event.type === "done") {
          setPendingPrompt(null);
          setWarning(event.warning);
          setView("done");
          void refresh();
        } else if (event.type === "error") {
          setPendingPrompt(null);
          setErrorMessage(event.message);
          setErrorReason(event.reason);
          setView("error");
        }
      };
      unsubRef.current = authFlowEventSource(flowId, {
        onEvent,
        onError: () => {
          if (genRef.current !== gen) return;
          setErrorMessage("Connection lost");
          setView("error");
        },
      });
    },
    [closeStream, refresh],
  );

  const respond = useCallback(async (value: string) => {
    if (!flowIdRef.current) return;
    await respondAuthFlow(flowIdRef.current, value);
    setPendingPrompt(null);
  }, []);

  const cancel = useCallback(async () => {
    if (flowIdRef.current) await cancelAuthFlow(flowIdRef.current);
  }, []);

  const backToList = useCallback(() => {
    closeStream();
    flowIdRef.current = null;
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

  const connectedCount = providers.filter((p) => p.authStatus?.configured).length;

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