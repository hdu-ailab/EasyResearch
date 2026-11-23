import { Copy, ExternalLink } from "lucide-react";
import { useId, useRef, useState } from "react";
import { type MarketSkillDto, skillMarketPageUrl } from "../../../../web/skill-marketplace-contracts";
import { useI18n } from "../../i18n/useI18n";

export function SkillMarketRecovery({ skill }: { skill: MarketSkillDto }) {
  const { t } = useI18n();
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState<"success" | "failed" | null>(null);
  const mounted = useRef(true);
  const url = skillMarketPageUrl(skill.source, skill.slug);
  const request = t("skillMarket.agentRequest")
    .replace("{identity}", () => JSON.stringify(skill.id))
    .replace("{url}", () => url);
  const copy = async () => {
    setCopied(null);
    try {
      await navigator.clipboard.writeText(request);
      if (mounted.current) setCopied("success");
    } catch {
      if (!mounted.current) return;
      setCopied("failed");
      field.current?.focus();
      field.current?.select();
    }
  };
  return (
    <section
      className="er-market-recovery"
      ref={(element) => {
        mounted.current = element !== null;
      }}
    >
      <div className="er-market-recovery-actions">
        <a href={url} target="_blank" rel="noreferrer">
          <ExternalLink size={14} aria-hidden />
          {t("skillMarket.manualDownload")}
        </a>
        <button type="button" onClick={() => void copy()}>
          <Copy size={14} aria-hidden />
          {t("skillMarket.copyRequest")}
        </button>
      </div>
      <label htmlFor={id}>{t("skillMarket.installRequest")}</label>
      <textarea ref={field} id={id} readOnly value={request} rows={5} />
      <p role="status">
        {copied === "success"
          ? t("skillMarket.copySuccess")
          : copied === "failed"
            ? t("skillMarket.copyFailed")
            : t("skillMarket.manualHint")}
      </p>
    </section>
  );
}
