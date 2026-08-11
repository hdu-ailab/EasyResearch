import { useEffect, useState } from "react";
import { ChevronLeft, Save, X } from "lucide-react";
import { ApiError, listConfigProjects, readConfigFile, writeConfigFile } from "../api";
import { useI18n } from "../i18n/useI18n";
import type { ConfigProjectsDto } from "../types";
import { ProductMark, Topbar } from "../components/Topbar";

export interface ConfigPageProps {
  onBack: () => void;
}

type Root = { kind: "home" } | { kind: "project"; cwd: string };

const settingsPath = (root: Root) =>
  root.kind === "home" ? "~/.lazyresearch/agent/settings.json" : `${root.cwd}/.lazyresearch/settings.json`;

/**
 * Homepage settings page: project folders list (home pinned first) leading to
 * a per-scope settings.json editor with field help.
 */
export function ConfigPage({ onBack }: ConfigPageProps) {
  const { t } = useI18n();
  const [data, setData] = useState<ConfigProjectsDto | null>(null);
  const [selected, setSelected] = useState<Root | null>(null);
  const [content, setContent] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    listConfigProjects()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const open = async (root: Root) => {
    setSelected(root);
    setSaved(false);
    setHelp(false);
    setError(null);
    try {
      const file = await readConfigFile(
        root.kind === "home" ? "global" : "project",
        root.kind === "home" ? undefined : root.cwd,
        "settings.json",
      );
      let pretty = file.content;
      try {
        pretty = JSON.stringify(JSON.parse(file.content), null, 2);
      } catch {
        // keep raw content when the file is not valid JSON
      }
      setContent(pretty);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setContent("{}");
      } else {
        setSelected(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const save = async () => {
    if (!selected) return;
    try {
      JSON.parse(content);
    } catch {
      setError(t("config.invalidJson"));
      setSaved(false);
      return;
    }
    try {
      await writeConfigFile(
        selected.kind === "home" ? "global" : "project",
        selected.kind === "home" ? undefined : selected.cwd,
        "settings.json",
        content,
      );
      setSaved(true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaved(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <Topbar
        home={{ active: false, onClick: onBack }}
        leading={<ProductMark />}
        center={<span className="truncate text-[13px] text-v2-text-text-muted">{t("configPage.title")}</span>}
      />
      <div className="min-h-0 flex-1 px-4 pb-4 pt-[4px]">
        {selected ? (
          <section className="relative mx-auto flex h-full w-full max-w-[980px] flex-col rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]" aria-label={t("configPage.editorAria")}>
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-v2-grey-200 px-2">
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100"
                aria-label={t("configPage.backToProjects")}
                title={t("configPage.backToProjects")}
                onClick={() => setSelected(null)}
              >
                <ChevronLeft size={15} />
              </button>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-v2-text-text-muted">{settingsPath(selected)}</span>
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100"
                aria-label="?"
                title={t("configPage.fieldHelp")}
                onClick={() => setHelp((v) => !v)}
              >
                ?
              </button>
            </div>
            <textarea
              className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[12px] leading-[1.5] text-v2-text-text-base outline-none"
              aria-label={t("configPage.settingsJson")}
              spellCheck={false}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
            <div className="flex shrink-0 items-center gap-1 border-t border-v2-grey-200 p-2">
              <button type="button" className="flex h-7 items-center gap-1 rounded-md bg-v2-grey-1100 px-3 text-[12px] font-medium text-v2-grey-50 transition-opacity hover:opacity-90" aria-label={t("config.save")} onClick={() => void save()}>
                <Save size={13} />
                {t("config.save")}
              </button>
              {saved && !error && <p className="ml-2 text-[12px] text-v2-text-text-muted">{t("config.saved")}</p>}
            </div>
            {error && <p className="border-t border-v2-grey-200 px-3 py-2 text-[12px] text-v2-status-error" role="alert">{error}</p>}
            {help && (
              <div
                role="dialog"
                aria-label={t("configPage.helpDialog")}
                className="absolute inset-0 z-10 flex items-center justify-center bg-v2-background-overlay p-6"
              >
                <div className="max-h-full w-full max-w-[560px] overflow-y-auto rounded-[10px] bg-v2-background-bg-base p-5 shadow-[var(--v2-elevation-raised)]">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-[13px] font-semibold text-v2-text-text-base">{t("configPage.helpTitle")}</h2>
                    <button
                      type="button"
                      className="flex size-7 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100"
                      aria-label={t("configPage.closeHelp")}
                      onClick={() => setHelp(false)}
                    >
                      <X size={15} />
                    </button>
                  </div>
                  <p className="mb-2 text-[13px] text-v2-text-text-base">
                    {t("configPage.helpIntro")}
                  </p>
                  <ul className="mb-3 list-disc pl-5 text-[13px] text-v2-text-text-base">
                    <li>{t("configPage.helpAgentModels")}</li>
                  </ul>
                  <p className="mb-1 text-[13px] text-v2-text-text-muted">{t("configPage.helpExample")}</p>
                  <pre className="whitespace-pre-wrap break-words rounded-md bg-v2-grey-100 p-3 font-mono text-[12px] leading-[1.5] text-v2-text-text-base">{`{
  "lazyresearch": {
    "agents": {
      "search": { "model": "provider/model-id" }
    }
  }
}`}</pre>
                </div>
              </div>
            )}
          </section>
        ) : (
          <section className="mx-auto flex h-full w-full max-w-[980px] flex-col rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]" aria-label={t("configPage.settingsRoot")}>
            <div className="flex h-10 shrink-0 items-center border-b border-v2-grey-200 px-3">
              <span className="text-[12px] text-v2-text-text-muted">{t("configPage.chooseScope")}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {data ? (
                <ul role="list" aria-label={t("configPage.projectFolders")} className="flex flex-col gap-0.5">
                  <li>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-v2-grey-100"
                      onClick={() => void open({ kind: "home" })}
                    >
                      <span className="text-[13px] font-medium text-v2-text-text-base">{t("configPage.homeLabel")}</span>
                      <span className="ml-auto truncate font-mono text-[12px] text-v2-text-text-muted">{data.home}</span>
                    </button>
                  </li>
                  {data.projects.map((project) => (
                    <li key={project.cwd}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[12px] text-v2-text-text-base transition-colors hover:bg-v2-grey-100"
                        onClick={() => void open({ kind: "project", cwd: project.cwd })}
                      >
                        {project.cwd}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="flex flex-1 items-center justify-center text-[13px] text-v2-text-text-faint">{t("configPage.loadingFolders")}</p>
              )}
              {error && <p className="border-t border-v2-grey-200 px-3 py-2 text-[12px] text-v2-status-error" role="alert">{error}</p>}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
