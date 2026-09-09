import { useI18n } from "../i18n/useI18n";

export function ThinkingPreview({ text, active, open }: { text: string; active: boolean; open: boolean }) {
  const { t } = useI18n();
  const preview =
    active && !open
      ? text
          .split(/\r?\n/)
          .findLast((line) => line.trim())
          ?.trim()
      : undefined;

  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="shrink-0 text-v2-text-text-faint">
        {active ? t("transcript.thinking") : t("transcript.thinkingProcess")}
        {preview ? ":" : null}
      </span>{" "}
      {preview ? (
        <span className="min-w-0 truncate text-[12.5px] font-normal text-v2-text-text-muted">{preview}</span>
      ) : null}
    </span>
  );
}
