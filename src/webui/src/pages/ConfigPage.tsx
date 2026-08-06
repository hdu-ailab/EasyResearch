import { useEffect, useState } from "react";
import { ChevronLeft, Save, X } from "lucide-react";
import { ApiError, listConfigProjects, readConfigFile, writeConfigFile } from "../api";
import type { ConfigProjectsDto } from "../types";
import { BackButton, ProductMark, Topbar } from "../components/Topbar";

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
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const save = async () => {
    if (!selected) return;
    try {
      JSON.parse(content);
    } catch {
      setError("Invalid JSON — the file was not saved.");
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
        leading={
          <>
            <BackButton onClick={onBack} />
            <ProductMark />
          </>
        }
        center={<span className="truncate text-[13px] text-v2-text-text-muted">Settings — global &amp; project config</span>}
      />
      <div className="min-h-0 flex-1 p-4">
        {selected ? (
          <section className="relative mx-auto flex h-full w-full max-w-[980px] flex-col rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]" aria-label="Settings editor">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-v2-grey-200 px-2">
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100"
                aria-label="Back to projects"
                title="Back to projects"
                onClick={() => setSelected(null)}
              >
                <ChevronLeft size={15} />
              </button>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-v2-text-text-muted">{settingsPath(selected)}</span>
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100"
                aria-label="?"
                title="Field help"
                onClick={() => setHelp((v) => !v)}
              >
                ?
              </button>
            </div>
            <textarea
              className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[12px] leading-[1.5] text-v2-text-text-base outline-none"
              aria-label="settings.json"
              spellCheck={false}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
            <div className="flex shrink-0 items-center gap-1 border-t border-v2-grey-200 p-2">
              <button type="button" className="flex h-7 items-center gap-1 rounded-md bg-v2-grey-1100 px-3 text-[12px] font-medium text-v2-grey-50 transition-opacity hover:opacity-90" aria-label="Save" onClick={() => void save()}>
                <Save size={13} />
                Save
              </button>
              {saved && !error && <p className="ml-2 text-[12px] text-v2-text-text-muted">Saved — applies after restart.</p>}
            </div>
            {error && <p className="border-t border-v2-grey-200 px-3 py-2 text-[12px] text-v2-status-error" role="alert">{error}</p>}
            {help && (
              <div
                role="dialog"
                aria-label="Settings help"
                className="absolute inset-0 z-10 flex items-center justify-center bg-v2-background-overlay p-6"
              >
                <div className="max-h-full w-full max-w-[560px] overflow-y-auto rounded-[10px] bg-v2-background-bg-base p-5 shadow-[var(--v2-elevation-raised)]">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-[13px] font-semibold text-v2-text-text-base">lazyresearch settings</h2>
                    <button
                      type="button"
                      className="flex size-7 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100"
                      aria-label="Close help"
                      onClick={() => setHelp(false)}
                    >
                      <X size={15} />
                    </button>
                  </div>
                  <p className="mb-2 text-[13px] text-v2-text-text-base">
                    The <code className="font-mono text-[12px]">lazyresearch</code> namespace holds behavioral settings. Fields:
                  </p>
                  <ul className="mb-3 list-disc pl-5 text-[13px] text-v2-text-text-base">
                    <li>
                      <code className="font-mono text-[12px]">agentModels</code>: map of agent name → <code className="font-mono text-[12px]">"provider/id"</code> model override.
                    </li>
                  </ul>
                  <p className="mb-1 text-[13px] text-v2-text-text-muted">Example:</p>
                  <pre className="overflow-x-auto rounded-md bg-v2-grey-100 p-3 font-mono text-[12px] leading-[1.5] text-v2-text-text-base">{`{"lazyresearch":{"agentModels":{"search":"openai/gpt-4o","writing":"anthropic/claude-sonnet-4"}}}`}</pre>
                </div>
              </div>
            )}
          </section>
        ) : (
          <section className="mx-auto flex h-full w-full max-w-[980px] flex-col rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]" aria-label="Settings root">
            <div className="flex h-10 shrink-0 items-center border-b border-v2-grey-200 px-3">
              <span className="text-[12px] text-v2-text-text-muted">Choose a scope to edit its settings.json</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {data ? (
                <ul role="list" aria-label="Project folders" className="flex flex-col gap-0.5">
                  <li>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-v2-grey-100"
                      onClick={() => void open({ kind: "home" })}
                    >
                      <span className="text-[13px] font-medium text-v2-text-text-base">~（全局配置）</span>
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
                <p className="flex flex-1 items-center justify-center text-[13px] text-v2-text-text-faint">Loading project folders…</p>
              )}
              {error && <p className="border-t border-v2-grey-200 px-3 py-2 text-[12px] text-v2-status-error" role="alert">{error}</p>}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
