import { AlertTriangle, Check, ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useExpandable } from "../hooks/useExpandable";
import { agentDisplayName } from "../i18n/agents";
import { useI18n } from "../i18n/useI18n";
import type { ToolView } from "../session-reducer";
import { MarkdownBlock } from "./MarkdownBlock";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION_QUERY).matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  return reducedMotion;
}

export function subagentMessagePreview(text: string, maxLength = 240): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

export function SubagentToolCard({
  tool,
  initialOpen,
  open,
  onToggle,
  onViewDetails,
}: {
  tool: ToolView;
  initialOpen: boolean;
  /** Controlled expansion state (virtualized lists keep state across unmounts). */
  open?: boolean;
  /** Called with the next expansion state when `open` is controlled. */
  onToggle?: (open: boolean) => void;
  onViewDetails?: (toolCallId: string, step?: number) => void;
}) {
  const { t } = useI18n();
  const [internalOpen, setInternalOpen] = useState(initialOpen);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setOpen = isControlled ? (onToggle ?? (() => {})) : setInternalOpen;
  const reducedMotion = usePrefersReducedMotion();
  const { mounted, phase } = useExpandable(isOpen);
  const activity = tool.latestActivity;
  const isToolActivity = activity?.kind === "tool";
  const message = activity
    ? activity.kind === "tool"
      ? `${activity.name}${activity.args ? ` ${activity.args}` : ""}`
      : activity.text
    : (tool.latestMessage ?? tool.output ?? "");
  const agentName = agentDisplayName(t, tool.agentName ?? "subagent");
  const running = tool.running && !tool.done;
  const emptyMessage = running ? t("transcript.waitingForProgress") : t("transcript.noSavedProgress");
  const state = tool.error
    ? t("transcript.subagentFailed")
    : tool.done
      ? t("transcript.subagentCompleted")
      : running
        ? t("transcript.running")
        : t("transcript.subagentProgress");
  const step = tool.step !== undefined ? `${t("transcript.subagentStep")} ${tool.step}` : undefined;
  const mappedLinks =
    tool.sessionLinks ??
    (tool.sessionId
      ? [
          {
            toolCallId: tool.key,
            childSessionId: tool.sessionId,
            agent: tool.agentName ?? "subagent",
            ...(tool.step !== undefined ? { step: tool.step } : {}),
          },
        ]
      : []);
  const canViewDetails = onViewDetails !== undefined && (running || mappedLinks.length > 0);
  const stateClass = running
    ? reducedMotion
      ? "border border-v2-blue-200"
      : "v2-subagent-card-running p-px"
    : tool.error
      ? "border border-v2-status-error/30"
      : "border border-v2-grey-200";

  return (
    <li className="w-full">
      <article className={`relative isolate w-full overflow-hidden rounded-lg ${stateClass}`}>
        <div className="relative z-[1] rounded-[7px] bg-v2-background-bg-base px-3 py-2">
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left text-[12px] text-v2-text-text-muted transition-colors hover:text-v2-text-text-base"
            aria-expanded={isOpen}
            onClick={() => setOpen(!isOpen)}
          >
            <span className="sr-only">{isOpen ? t("transcript.hideDetails") : t("transcript.showDetails")}</span>
            {running ? <span className="v2-spinner shrink-0" aria-hidden /> : null}
            {tool.done && !tool.error ? (
              <Check className="shrink-0 text-v2-status-success" size={14} aria-hidden />
            ) : null}
            {tool.error ? <AlertTriangle className="shrink-0 text-v2-status-error" size={14} aria-hidden /> : null}
            <span className="min-w-0 flex-1 truncate font-medium text-v2-text-text-base">{agentName}</span>
            <span className={tool.error ? "text-v2-status-error" : "text-v2-text-text-faint"}>{state}</span>
            {step ? <span className="text-v2-text-text-faint">{step}</span> : null}
            {isOpen ? (
              <ChevronDown className="shrink-0" size={14} aria-hidden />
            ) : (
              <ChevronRight className="shrink-0" size={14} aria-hidden />
            )}
          </button>

          {!mounted ? (
            <p className="mt-1.5 line-clamp-3 text-[length:var(--v2-chat-font-size)] leading-relaxed text-v2-text-text-muted">
              {message ? subagentMessagePreview(message) : emptyMessage}
            </p>
          ) : null}

          {mounted ? (
            <div
              className={`mt-1.5 text-[length:var(--v2-chat-font-size)] text-v2-text-text-base ${
                isToolActivity
                  ? "whitespace-pre-wrap break-words font-mono text-[12px] text-v2-text-text-muted"
                  : "v2-md"
              } ${phase === "enter" ? "animate-v2-expand-down" : "animate-v2-collapse-up"} motion-reduce:animate-none`}
            >
              {message ? (
                isToolActivity ? (
                  message
                ) : (
                  <MarkdownBlock text={message} />
                )
              ) : (
                <p className="text-v2-text-text-faint">{emptyMessage}</p>
              )}
            </div>
          ) : null}
          {canViewDetails && mappedLinks.length > 1 ? (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {mappedLinks.map((link) => {
                const linkStep =
                  link.step === undefined
                    ? t("transcript.viewDetails")
                    : `${t("transcript.subagentStep")} ${link.step}`;
                return (
                  <button
                    key={`${link.childSessionId}:${link.step ?? "single"}`}
                    type="button"
                    aria-label={`${t("transcript.viewDetails")}: ${linkStep}`}
                    onClick={() => onViewDetails(tool.key, link.step)}
                    className="text-[12px] font-medium text-v2-blue-600 hover:text-v2-blue-700"
                  >
                    {linkStep}
                  </button>
                );
              })}
            </div>
          ) : canViewDetails ? (
            <button
              type="button"
              onClick={() => {
                const detailStep = mappedLinks[0]?.step ?? tool.step;
                if (detailStep === undefined) onViewDetails(tool.key);
                else onViewDetails(tool.key, detailStep);
              }}
              className="mt-2 text-[12px] font-medium text-v2-blue-600 hover:text-v2-blue-700"
            >
              {t("transcript.viewDetails")}
            </button>
          ) : null}
        </div>
      </article>
    </li>
  );
}
