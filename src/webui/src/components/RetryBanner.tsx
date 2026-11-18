import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import type { RetryView } from "../session-reducer";
import { useViewActivity } from "../view-activity";

export function RetryBanner({ retry, agentLabel }: { retry: RetryView; agentLabel?: string }) {
  const { t } = useI18n();
  const { visible, interactive } = useViewActivity();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      setNow(now);
      if (retry.endsAt > now) timer = setTimeout(update, Math.min(1000, retry.endsAt - now));
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [visible, retry.endsAt]);
  const remaining = Math.max(0, Math.ceil((retry.endsAt - now) / 1000));
  const retrying = t("work.retrying")
    .replace("{attempt}", String(retry.attempt))
    .replace("{maxAttempts}", String(retry.maxAttempts));
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-v2-grey-200 bg-v2-status-warning/10 px-4 py-1.5 text-[13px] text-v2-status-warning">
      <RefreshCw size={13} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
      <span role="status" aria-live={interactive ? "polite" : "off"} className="min-w-0 break-words">
        {agentLabel ? `${agentLabel} · ` : ""}
        {retrying}
        {retry.source && retry.source !== "agent"
          ? ` · ${t(retry.source === "compaction" ? "work.retryCompaction" : "work.retryBranchSummary")}`
          : ""}
      </span>
      <span className="shrink-0" aria-live="off">
        {remaining > 0 ? t("work.retryIn").replace("{seconds}", String(remaining)) : t("work.retryingNow")}
      </span>
      {retry.errorMessage ? (
        <span className="min-w-0 flex-1 truncate text-v2-text-text-muted" title={retry.errorMessage}>
          {retry.errorMessage}
        </span>
      ) : null}
    </div>
  );
}
