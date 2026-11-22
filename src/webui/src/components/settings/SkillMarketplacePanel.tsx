import { Check, Download, Plus, RefreshCw, Search, Sparkles } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { SkillResourceDto } from "../../../../web/contracts";
import type { MarketSkillDto, SkillMarketView } from "../../../../web/skill-marketplace-contracts";
import { getSkillMarket } from "../../api/skill-marketplace";
import { useI18n } from "../../i18n/useI18n";
import { SkillMarketDetailDialog } from "./SkillMarketDetailDialog";
import "./skill-marketplace.css";

const topics = [
  ["all", ""],
  ["research", "research"],
  ["writing", "writing"],
  ["data", "data analysis"],
  ["development", "development"],
  ["design", "design"],
  ["testing", "testing"],
] as const;

function SkillCard({ skill, installed, onSelect }: { skill: MarketSkillDto; installed: boolean; onSelect(): void }) {
  const { t, language } = useI18n();
  const count = new Intl.NumberFormat(language, { notation: "compact", maximumFractionDigits: 1 }).format(
    skill.installs,
  );
  return (
    <article className="er-market-card">
      <span className="er-market-avatar" aria-hidden>
        {skill.name.slice(0, 1).toUpperCase()}
      </span>
      <header>
        <h4>
          <button
            type="button"
            onClick={onSelect}
            disabled={!skill.supported}
            aria-label={t("skillMarket.viewDetail").replace("{name}", skill.name)}
          >
            {skill.name}
          </button>
        </h4>
        <p title={skill.description ?? skill.source}>{skill.description ?? skill.source}</p>
      </header>
      <button
        type="button"
        className="er-market-add"
        aria-label={t(installed ? "skillMarket.viewInstalled" : "skillMarket.add").replace("{name}", skill.name)}
        title={t(installed ? "skillMarket.viewInstalled" : "skillMarket.add").replace("{name}", skill.name)}
        disabled={!skill.supported}
        onClick={onSelect}
      >
        {installed ? <Check size={16} aria-hidden /> : <Plus size={16} aria-hidden />}
      </button>
      <footer>
        <span>
          <Download size={13} aria-hidden />
          {t("skillMarket.installs").replace("{n}", count)}
        </span>
        {installed ? (
          <span>{t("skillMarket.installedState")}</span>
        ) : !skill.supported ? (
          <span>{t("skillMarket.unsupported")}</span>
        ) : null}
      </footer>
    </article>
  );
}

export function SkillMarketplacePanel({
  active,
  skills,
  onInstalled,
}: {
  active: boolean;
  skills: readonly SkillResourceDto[];
  onInstalled(): void;
}) {
  const { t } = useI18n();
  const searchId = useId();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState<string>("all");
  const [view, setView] = useState<SkillMarketView>("all-time");
  const [items, setItems] = useState<MarketSkillDto[]>([]);
  const [popular, setPopular] = useState<MarketSkillDto[]>([]);
  const [popularOffset, setPopularOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<MarketSkillDto | null>(null);
  const [notice, setNotice] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  const installed = new Set([
    ...skills.flatMap((skill) => (skill.marketplaceId ? [skill.marketplaceId] : [])),
    ...added,
  ]);

  useEffect(() => {
    void skills;
    setAdded([]);
  }, [skills]);

  useEffect(() => {
    if (!active) return;
    void retry;
    const controller = new AbortController();
    setLoading(true);
    setNotice("");
    setError(null);
    setItems([]);
    void getSkillMarket(query, view, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setItems(result.skills);
        if (!query && view === "all-time") setPopular(result.skills.filter((skill) => skill.supported).slice(0, 12));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("skillMarket.empty"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [active, query, view, retry, t]);

  const cards = (rows: MarketSkillDto[]) =>
    rows.map((skill) => (
      <SkillCard key={skill.id} skill={skill} installed={installed.has(skill.id)} onSelect={() => setSelected(skill)} />
    ));

  return (
    <div className="er-market">
      <div className="er-market-toolbar">
        <a href="https://skills.sh" target="_blank" rel="noreferrer" className="er-market-source">
          skills.sh
        </a>
        <form
          className="er-market-search"
          onSubmit={(event) => {
            event.preventDefault();
            const next = input.trim();
            if (next.length === 1) {
              setError(t("skillMarket.shortQuery"));
              return;
            }
            setTopic("all");
            setQuery(next);
            if (query === next) setRetry((value) => value + 1);
          }}
        >
          <label htmlFor={searchId} className="sr-only">
            {t("skillMarket.search")}
          </label>
          <Search size={16} aria-hidden />
          <input
            id={searchId}
            type="search"
            maxLength={160}
            placeholder={t("skillMarket.search")}
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
          <button type="submit">{t("skillMarket.submit")}</button>
        </form>
      </div>

      {popular.length > 0 && !query && (
        <section>
          <div className="er-market-section-heading">
            <h3>
              <Sparkles size={16} aria-hidden />
              {t("skillMarket.popular")}
            </h3>
            <button type="button" onClick={() => setPopularOffset((value) => (value + 3) % popular.length)}>
              <RefreshCw size={14} aria-hidden />
              {t("skillMarket.morePopular")}
            </button>
          </div>
          <div className="er-market-grid">{cards(popular.slice(popularOffset, popularOffset + 3))}</div>
        </section>
      )}

      <section>
        <div className="er-market-section-heading">
          <h3>{t("skillMarket.catalog")}</h3>
          {!query && (
            <fieldset className="er-market-switch">
              <legend className="sr-only">{t("skillMarket.views")}</legend>
              {(["all-time", "trending", "hot"] as const).map((value) => (
                <button type="button" key={value} aria-pressed={view === value} onClick={() => setView(value)}>
                  {t(
                    value === "all-time"
                      ? "skillMarket.allTime"
                      : value === "trending"
                        ? "skillMarket.trending"
                        : "skillMarket.hot",
                  )}
                </button>
              ))}
            </fieldset>
          )}
        </div>
        <fieldset className="er-market-topics">
          <legend className="sr-only">{t("skillMarket.topics")}</legend>
          {topics.map(([key, value]) => (
            <button
              key={key}
              type="button"
              aria-pressed={topic === key}
              onClick={() => {
                setTopic(key);
                setInput(value);
                setQuery(value);
              }}
            >
              {t(`skillMarket.${key}`)}
            </button>
          ))}
        </fieldset>
        {error && (
          <div className="er-market-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              {t("dialog.retry")}
            </button>
          </div>
        )}
        <p className="er-market-status" role="status">
          {notice || (loading ? t("dialog.loading") : t("skillMarket.results").replace("{n}", String(items.length)))}
        </p>
        <div className="er-market-grid" aria-busy={loading}>
          {cards(items)}
        </div>
        {!loading && !error && items.length === 0 && <p className="er-market-empty">{t("skillMarket.empty")}</p>}
      </section>
      {selected && active && (
        <SkillMarketDetailDialog
          skill={selected}
          onClose={() => setSelected(null)}
          onInstalled={(name) => {
            setAdded((current) => [...current, selected.id]);
            setNotice(t("skillMarket.installedNotice").replace("{name}", name));
            onInstalled();
          }}
        />
      )}
    </div>
  );
}
