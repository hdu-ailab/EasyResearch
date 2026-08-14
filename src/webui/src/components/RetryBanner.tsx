import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import type { RetryView } from "../session-reducer";

export function RetryBanner({ retry }: { retry: RetryView }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const remaining = Math.max(0, Math.ceil((retry.endsAt - now) / 1000));
  const retrying = t("work.retrying")
    .replace("{attempt}", String(retry.attempt))
    .replace("{maxAttempts}", String(retry.maxAttempts));
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-v2-grey-200 bg-v2-status-warning/10 px-4 py-1.5 text-[13px] text-v2-status-warning"
    >
      <RefreshCw size={13} className="animate-spin" aria-hidden />
      <span className="shrink-0">{retrying}</span>
      <span className="shrink-0">
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
