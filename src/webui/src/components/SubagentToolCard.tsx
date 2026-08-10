import { useEffect, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight } from "lucide-react";
import type { ToolView } from "../session-reducer";
import { useExpandable } from "../hooks/useExpandable";
import { agentDisplayName } from "../i18n/agents";
import { useI18n } from "../i18n/useI18n";
import { MarkdownBlock } from "./MarkdownBlock";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION_QUERY).matches,
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

export function SubagentToolCard({ tool, initialOpen }: { tool: ToolView; initialOpen: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(initialOpen);
  const reducedMotion = usePrefersReducedMotion();
  const { mounted, phase } = useExpandable(open);
  const message = tool.latestMessage ?? tool.output ?? "";
  const agentName = agentDisplayName(t, tool.agentName ?? "subagent");
  const running = tool.running && !tool.done;
  const state = tool.error
    ? t("transcript.subagentFailed")
    : tool.done
      ? t("transcript.subagentCompleted")
      : running
        ? t("transcript.running")
        : t("transcript.subagentProgress");
  const step = tool.step !== undefined ? `${t("transcript.subagentStep")} ${tool.step}` : undefined;
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
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <span className="sr-only">{open ? t("transcript.hideDetails") : t("transcript.showDetails")}</span>
            {running ? <span className="v2-spinner shrink-0" aria-hidden /> : null}
            {tool.done && !tool.error ? <Check className="shrink-0 text-v2-status-success" size={14} aria-hidden /> : null}
            {tool.error ? <AlertTriangle className="shrink-0 text-v2-status-error" size={14} aria-hidden /> : null}
            <span className="min-w-0 flex-1 truncate font-medium text-v2-text-text-base">{agentName}</span>
            <span className={tool.error ? "text-v2-status-error" : "text-v2-text-text-faint"}>{state}</span>
            {step ? <span className="text-v2-text-text-faint">{step}</span> : null}
            {open ? <ChevronDown className="shrink-0" size={14} aria-hidden /> : <ChevronRight className="shrink-0" size={14} aria-hidden />}
          </button>

          {!mounted ? (
            <p className="mt-1.5 line-clamp-3 text-[length:var(--v2-chat-font-size)] leading-relaxed text-v2-text-text-muted">
              {message ? subagentMessagePreview(message) : t("transcript.waitingForProgress")}
            </p>
          ) : null}

          {mounted ? (
            <div
              className={`v2-md mt-1.5 text-[length:var(--v2-chat-font-size)] text-v2-text-text-base ${
                phase === "enter" ? "animate-v2-expand-down" : "animate-v2-collapse-up"
              } motion-reduce:animate-none`}
            >
              {message ? <MarkdownBlock text={message} /> : <p className="text-v2-text-text-faint">{t("transcript.waitingForProgress")}</p>}
            </div>
          ) : null}
        </div>
      </article>
    </li>
  );
}
