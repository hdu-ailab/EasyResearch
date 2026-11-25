import { Check, Download, LoaderCircle, Plus, RefreshCw, Search, Sparkles } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { SkillResourceDto } from "../../../../web/contracts";
import type {
  MarketSkillDto,
  SkillMarketDetailDto,
  SkillMarketView,
} from "../../../../web/skill-marketplace-contracts";
import { skillMarketAuthorUrl } from "../../../../web/skill-marketplace-contracts";
import { getSkillMarket, getSkillMarketDetail, installMarketSkill } from "../../api/skill-marketplace";
import { useI18n } from "../../i18n/useI18n";
import { SkillMarketDetailDialog } from "./SkillMarketDetailDialog";
import { SkillMarketRecovery } from "./SkillMarketRecovery";
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

function SkillCard({
  skill,
  installed,
  onSelect,
  installing,
  error,
  onInstall,
}: {
  skill: MarketSkillDto;
  installed: boolean;
  onSelect(): void;
  installing: boolean;
  error?: string;
  onInstall(): void;
}) {
  const { t, language } = useI18n();
  const count = new Intl.NumberFormat(language, { notation: "compact", maximumFractionDigits: 1 }).format(
    skill.installs,
  );
  return (
    <article className="er-market-card" data-marketplace-id={skill.id}>
      <header>
        <h4>
          <button
            type="button"
            onClick={onSelect}
            className="er-market-preview"
            aria-label={t("skillMarket.viewDetail").replace("{name}", skill.name)}
          >
            <span className="er-market-title">{skill.name}</span>
          </button>
        </h4>
        <a className="er-market-author" href={skillMarketAuthorUrl(skill.source)} target="_blank" rel="noreferrer">
          {skill.source}
        </a>
      </header>
      <button
        type="button"
        className="er-market-add"
        aria-label={t(
          installing ? "skillMarket.installing" : installed ? "skillMarket.viewInstalled" : "skillMarket.add",
        ).replace("{name}", skill.name)}
        aria-busy={installing}
        disabled={installing}
        onClick={installed ? onSelect : onInstall}
      >
        {installing ? (
          <LoaderCircle size={16} aria-hidden />
        ) : installed ? (
          <Check size={16} aria-hidden />
        ) : (
          <Plus size={16} aria-hidden />
        )}
      </button>
      <p className="er-market-summary" title={skill.description || undefined}>
        {skill.description || ""}
      </p>
      <footer>
        <span>
          <Download size={13} aria-hidden />
          {t("skillMarket.installs").replace("{n}", count)}
        </span>
        {installed ? (
          <span>{t("skillMarket.installedState")}</span>
        ) : !skill.supported ? (
          <span>
            {t(
              skill.unsupportedReason === "identity"
                ? "skillMarket.unsupportedIdentity"
                : "skillMarket.unsupportedSource",
            )}
          </span>
        ) : null}
      </footer>
      {error && (
        <div className="er-market-card-recovery">
          <div className="er-market-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={onInstall} disabled={installing}>
              {t("dialog.retry")}
            </button>
          </div>
          <SkillMarketRecovery skill={skill} />
        </div>
      )}
    </article>
  );
}

export function SkillMarketplacePanel({
  active,
  skills,
  onInstalled,
  resourcesRevision = 0,
  deletion,
}: {
  active: boolean;
  skills: readonly SkillResourceDto[];
  onInstalled(): void;
  /** Only advances for a complete accepted list. */
  resourcesRevision?: number;
  deletion?: { id: string; revision: number } | null;
}) {
  const { t } = useI18n();
  const mounted = useRef(true);
  const latest = useRef({ resourcesRevision, onInstalled });
  latest.current = { resourcesRevision, onInstalled };
  const busy = useRef(new Set<string>());
  const [installing, setInstalling] = useState<ReadonlySet<string>>(new Set());
  const [installErrors, setInstallErrors] = useState<Record<string, string | undefined>>({});
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
  const [added, setAdded] = useState<Record<string, number>>({});
  const installed = new Set([
    ...skills.flatMap((skill) => (skill.marketplaceId ? [skill.marketplaceId] : [])),
    ...Object.keys(added),
  ]);

  useEffect(() => {
    // A list read admitted before the installation acknowledgement is not
    // evidence that the newly published Skill disappeared.
    setAdded((current) => {
      const entries = Object.entries(current).filter(([, revision]) => revision >= resourcesRevision);
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [resourcesRevision]);

  useEffect(() => {
    if (!deletion) return;
    setAdded((current) => {
      if (!(deletion.id in current)) return current;
      const next = { ...current };
      delete next[deletion.id];
      return next;
    });
  }, [deletion]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const install = async (skill: MarketSkillDto, preview?: SkillMarketDetailDto) => {
    if (busy.current.has(skill.id) || installed.has(skill.id)) return;
    busy.current.add(skill.id);
    setInstalling(new Set(busy.current));
    setInstallErrors((current) => ({ ...current, [skill.id]: undefined }));
    try {
      if (!skill.supported) {
        throw new Error(
          t(
            skill.unsupportedReason === "identity"
              ? "skillMarket.unsupportedIdentity"
              : "skillMarket.unsupportedSource",
          ),
        );
      }
      // Direct installation resolves exactly one immutable snapshot. Public-page
      // explanation reads belong exclusively to an explicitly opened preview.
      const detail = preview ?? (await getSkillMarketDetail(skill.id));
      if (detail.id !== skill.id) throw new Error(t("skillMarket.invalidResponse"));
      if (detail.state === "conflict") throw new Error(t("skillMarket.conflict"));
      const result = await installMarketSkill({ id: skill.id, commit: detail.commit });
      if (result.id !== skill.id) throw new Error(t("skillMarket.invalidResponse"));
      if (!mounted.current) return;
      const revision = latest.current.resourcesRevision;
      setAdded((current) => ({ ...current, [skill.id]: revision }));
      setNotice(t("skillMarket.installedNotice").replace("{name}", result.name));
      // Refence old reads synchronously before they can erase this acknowledgement.
      latest.current.onInstalled();
    } catch (cause) {
      if (mounted.current)
        setInstallErrors((current) => ({
          ...current,
          [skill.id]: cause instanceof Error ? cause.message : String(cause),
        }));
    } finally {
      busy.current.delete(skill.id);
      if (mounted.current) setInstalling(new Set(busy.current));
    }
  };

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
      <SkillCard
        key={skill.id}
        skill={skill}
        installed={installed.has(skill.id)}
        onSelect={() => setSelected(skill)}
        installing={installing.has(skill.id)}
        error={installErrors[skill.id]}
        onInstall={() => void install(skill)}
      />
    ));

  return (
    <div className="er-market">
      <div className="er-market-toolbar">
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
            data-settings-panel-focus
            type="search"
            maxLength={160}
            placeholder={t("skillMarket.search")}
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
          <button type="submit">{t("skillMarket.submit")}</button>
        </form>
      </div>
      <div className="er-market-content">
        <h2 className="sr-only">{t("skillMarket.title")}</h2>
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
      </div>
      {selected && active && (
        <SkillMarketDetailDialog
          skill={selected}
          onClose={() => setSelected(null)}
          installed={installed.has(selected.id)}
          installing={installing.has(selected.id)}
          installError={installErrors[selected.id]}
          onInstall={(detail) => void install(selected, detail)}
        />
      )}
    </div>
  );
}
