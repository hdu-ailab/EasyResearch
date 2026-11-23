import { Check, ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  MarketSkillDto,
  SkillMarketDescriptionDto,
  SkillMarketDetailDto,
} from "../../../../web/skill-marketplace-contracts";
import { skillMarketAuthorUrl } from "../../../../web/skill-marketplace-contracts";
import { getSkillMarketDescription, getSkillMarketDetail, installMarketSkill } from "../../api/skill-marketplace";
import { useModalLayer } from "../../hooks/useModalLayer";
import { useI18n } from "../../i18n/useI18n";
import { MarkdownBlock } from "../MarkdownBlock";
import { SkillMarketRecovery } from "./SkillMarketRecovery";

export function SkillMarketDetailDialog({
  skill,
  onClose,
  onInstalled,
}: {
  skill: MarketSkillDto;
  onClose(): void;
  onInstalled(name: string): void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const [detail, setDetail] = useState<SkillMarketDetailDto | null>(null);
  const [explanation, setExplanation] = useState<SkillMarketDescriptionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const close = () => {
    if (!busy.current) onClose();
  };
  const layer = useModalLayer(close, ref);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    void attempt;
    const controller = new AbortController();
    setDetail(null);
    setExplanation(null);
    setError(null);
    void getSkillMarketDescription(skill.id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setExplanation(value);
      })
      .catch(() => {
        /* The original SKILL.md remains the explanation fallback. */
      });
    void getSkillMarketDetail(skill.id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setDetail(result);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [skill.id, attempt]);

  const install = async () => {
    if (!detail || busy.current || detail.state !== "available") return;
    busy.current = true;
    setInstalling(true);
    setError(null);
    try {
      const installed = await installMarketSkill({ id: detail.id, commit: detail.commit });
      if (!mounted.current) return;
      setDetail({ ...detail, state: "installed" });
      onInstalled(installed.name);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false;
      if (mounted.current) setInstalling(false);
    }
  };
  return createPortal(
    <div className="er-market-detail-overlay" style={{ zIndex: layer.zIndex }}>
      <div ref={ref} role="dialog" {...layer.dialogProps} aria-label={skill.name} className="er-market-detail">
        <header>
          <div>
            <h2>{skill.name}</h2>
            <p>{skill.source}</p>
          </div>
          <button type="button" onClick={close} disabled={installing} aria-label={t("settings.close")}>
            <X size={18} aria-hidden />
          </button>
        </header>
        <div className="er-market-detail-body">
          {error && (
            <div role="alert" className="er-market-error">
              <span>{error}</span>
              {!detail && (
                <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                  {t("dialog.retry")}
                </button>
              )}
            </div>
          )}
          {!detail && !error && <p role="status">{t("dialog.loading")}</p>}
          {(error || detail?.state === "conflict") && <SkillMarketRecovery skill={skill} />}
          {detail && (
            <>
              <p>{detail.description}</p>
              <dl className="er-market-metadata">
                <dt>{t("skillMarket.source")}</dt>
                <dd>
                  <a href={detail.sourceUrl ?? skillMarketAuthorUrl(skill.source)} target="_blank" rel="noreferrer">
                    {skill.source}
                    <ExternalLink size={12} aria-hidden />
                  </a>
                </dd>
                <dt>{t(detail.sourceType === "well-known" ? "skillMarket.snapshot" : "skillMarket.commit")}</dt>
                <dd>
                  <code>{detail.commit}</code>
                </dd>
                <dt>{t("skillMarket.directory")}</dt>
                <dd>
                  <code>{detail.directory || "/"}</code>
                </dd>
              </dl>
              <details>
                <summary>{t("skillMarket.files").replace("{n}", String(detail.files.length))}</summary>
                <ul>
                  {detail.files.map((path) => (
                    <li key={path}>
                      <code>{path}</code>
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
          {(explanation || detail) && (
            <div className="er-market-markdown">
              {explanation && (
                <a href={explanation.url} target="_blank" rel="noreferrer">
                  {t("skillMarket.explanationSource")}
                  <ExternalLink size={12} aria-hidden />
                </a>
              )}
              <MarkdownBlock
                text={explanation?.content ?? detail?.content ?? ""}
                className="v2-md"
                scope={`market:${skill.id}`}
                cacheKey={explanation?.url ?? detail?.commit ?? "description"}
              />
              {explanation && detail && (
                <details className="er-market-full-source">
                  <summary>{t("skillMarket.fullSource")}</summary>
                  <MarkdownBlock
                    text={detail.content}
                    className="v2-md"
                    scope={`market-source:${skill.id}`}
                    cacheKey={detail.commit}
                  />
                </details>
              )}
            </div>
          )}
        </div>
        <footer>
          <p>{detail?.state === "conflict" ? t("skillMarket.conflict") : t("skillMarket.scope")}</p>
          <button
            type="button"
            className="er-market-primary"
            disabled={detail?.state !== "available" || installing}
            onClick={() => void install()}
          >
            {detail?.state === "installed" && <Check size={15} aria-hidden />}
            {t(
              installing
                ? "skillMarket.installing"
                : detail?.state === "installed"
                  ? "skillMarket.installedState"
                  : "skillMarket.install",
            )}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
