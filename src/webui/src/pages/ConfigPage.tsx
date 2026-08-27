import { ChevronLeft, FilePlus, Folder, FolderPlus, RefreshCw, Save, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ConfigEntryDto, ConfigScope } from "../../../web/contracts";
import {
  createConfigDirectory,
  listConfig,
  listConfigProjects,
  readConfigFile,
  refreshConfigurationResources,
  writeConfigFile,
} from "../api";
import { ProductMark, Topbar } from "../components/Topbar";
import { useModalLayer } from "../hooks/useModalLayer";
import { useI18n } from "../i18n/useI18n";
import type { ConfigProjectsDto } from "../types";

export interface ConfigPageProps {
  onHome(): void;
  onBackToSettings(): void;
  onProjectInterestChange(cwd?: string): void;
}

type Root = { kind: "home" } | { kind: "project"; cwd: string };

function rootScope(root: Root): { scope: ConfigScope; cwd?: string } {
  return root.kind === "home" ? { scope: "global" } : { scope: "project", cwd: root.cwd };
}

function savedMessage(root: Root, path: string): "config.saved" | "config.savedLive" | "config.savedRestart" {
  const parts = path.split(/[\\/]/);
  const filename = parts.at(-1) ?? "";
  const directMarkdown = parts.length === 2 && filename.length > ".md".length && filename.endsWith(".md");
  const agentMarkdown = parts[0] === "agents" && directMarkdown;
  const skillDescriptor = parts[0] === "skills" && (directMarkdown || (parts.length > 2 && filename === "SKILL.md"));
  if (skillDescriptor || (root.kind === "home" && (path === "models.json" || agentMarkdown))) {
    return "config.savedLive";
  }
  if (root.kind === "project" && agentMarkdown) return "config.saved";
  return "config.savedRestart";
}

export function ConfigPage({ onHome, onBackToSettings, onProjectInterestChange }: ConfigPageProps) {
  const { t } = useI18n();
  const [data, setData] = useState<ConfigProjectsDto | null>(null);
  const [selectedRoot, setSelectedRoot] = useState<Root | null>(null);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<ConfigEntryDto[]>([]);
  const [content, setContent] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dialog, setDialog] = useState<"file" | "directory" | null>(null);
  const [name, setName] = useState("");
  const entryRequest = useRef(0);

  const loadEntries = async (root: Root, nextPath = "", refreshError: string | null = null) => {
    const request = ++entryRequest.current;
    const params = rootScope(root);
    setError(null);
    try {
      const nextEntries = await listConfig(params.scope, params.cwd, nextPath || undefined);
      if (request !== entryRequest.current) return;
      setEntries(nextEntries);
      setPath(nextPath);
      setError(refreshError);
    } catch (e) {
      if (request === entryRequest.current) setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    listConfigProjects()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const selectedProjectCwd = selectedRoot?.kind === "project" ? selectedRoot.cwd : undefined;

  useEffect(() => {
    onProjectInterestChange(selectedProjectCwd);
  }, [onProjectInterestChange, selectedProjectCwd]);

  useEffect(
    () => () => {
      onProjectInterestChange(undefined);
      entryRequest.current += 1;
    },
    [onProjectInterestChange],
  );

  const openRoot = async (root: Root) => {
    setSelectedRoot(root);
    setSelectedFile(null);
    setContent("");
    await loadEntries(root);
  };

  const closeRoot = () => {
    entryRequest.current += 1;
    setSelectedRoot(null);
    setSelectedFile(null);
    setContent("");
    setPath("");
    setEntries([]);
    setError(null);
  };

  const refreshEntries = async () => {
    if (!selectedRoot) return;
    const root = selectedRoot;
    const currentPath = path;
    const request = ++entryRequest.current;
    try {
      const result = await refreshConfigurationResources(root.kind === "project" ? { projectCwds: [root.cwd] } : {});
      if (request !== entryRequest.current) return;
      await loadEntries(root, currentPath, result.error);
    } catch (cause) {
      if (request === entryRequest.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const openFile = async (entry: ConfigEntryDto) => {
    if (!selectedRoot || entry.type !== "file") return;
    const request = ++entryRequest.current;
    try {
      const file = await readConfigFile(rootScope(selectedRoot).scope, rootScope(selectedRoot).cwd, entry.path);
      if (request !== entryRequest.current) return;
      setSelectedFile(entry.path);
      setContent(file.content);
      setSaved(false);
      setError(null);
    } catch (e) {
      if (request === entryRequest.current) setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    if (!selectedRoot || !selectedFile) return;
    if (selectedFile.endsWith(".json")) {
      try {
        JSON.parse(content);
      } catch {
        setError(t("config.invalidJson"));
        return;
      }
    }
    try {
      const params = rootScope(selectedRoot);
      await writeConfigFile(params.scope, params.cwd, selectedFile, content);
      setSaved(true);
      setError(null);
      await loadEntries(selectedRoot, path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const create = async () => {
    if (!selectedRoot || !name.trim()) return;
    const nextPath = path ? `${path}/${name.trim()}` : name.trim();
    try {
      const params = rootScope(selectedRoot);
      if (dialog === "directory") {
        await createConfigDirectory(params.scope, params.cwd, nextPath);
        await loadEntries(selectedRoot, path);
      } else {
        await writeConfigFile(params.scope, params.cwd, nextPath, nextPath.endsWith(".json") ? "{}\n" : "");
        await loadEntries(selectedRoot, path);
        setSelectedFile(nextPath);
        setContent(nextPath.endsWith(".json") ? "{}\n" : "");
      }
      setDialog(null);
      setName("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <Topbar
        home={{ active: false, onClick: onHome }}
        leading={
          <>
            <button
              type="button"
              className="flex h-[28px] shrink-0 items-center gap-1 rounded-md px-2 text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-100 hover:text-v2-text-text-base"
              onClick={onBackToSettings}
            >
              <ChevronLeft size={14} aria-hidden />
              {t("config.backToSettings")}
            </button>
            <ProductMark />
          </>
        }
        center={<span className="truncate text-[13px] text-v2-text-text-muted">{t("config.browser")}</span>}
      />
      <div className="min-h-0 flex-1 px-4 pb-4 pt-[4px]">
        {!selectedRoot ? (
          <section className="mx-auto flex h-full w-full max-w-[980px] flex-col rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
            <div className="border-b border-v2-grey-200 px-3 py-2 text-[12px] text-v2-text-text-muted">
              {t("config.scope")}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {data && (
                <ul aria-label={t("config.projectFolder")} className="flex flex-col gap-1">
                  <li>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-v2-grey-100"
                      onClick={() => void openRoot({ kind: "home" })}
                    >
                      <Folder size={14} />
                      {t("config.global")}
                      <span className="ml-auto font-mono text-[12px] text-v2-text-text-muted">{data.home}</span>
                    </button>
                  </li>
                  {data.projects.map((project) => (
                    <li key={project.cwd}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left font-mono text-[12px] hover:bg-v2-grey-100"
                        onClick={() => void openRoot({ kind: "project", cwd: project.cwd })}
                      >
                        <Folder size={14} />
                        {project.cwd}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {error && (
                <p role="alert" className="mt-2 text-[12px] text-v2-status-error">
                  {error}
                </p>
              )}
            </div>
          </section>
        ) : (
          <section className="mx-auto flex h-full w-full max-w-[1080px] flex-col rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
            <header className="flex h-10 shrink-0 items-center gap-1 border-b border-v2-grey-200 px-2">
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-md hover:bg-v2-grey-100"
                aria-label={t("config.backToFiles")}
                onClick={closeRoot}
              >
                <ChevronLeft size={15} />
              </button>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-v2-text-text-muted">
                {path || "."}
              </span>
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-md hover:bg-v2-grey-100"
                title={t("config.newFile")}
                aria-label={t("config.newFile")}
                onClick={() => setDialog("file")}
              >
                <FilePlus size={14} />
              </button>
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-md hover:bg-v2-grey-100"
                title={t("config.newFolder")}
                aria-label={t("config.newFolder")}
                onClick={() => setDialog("directory")}
              >
                <FolderPlus size={14} />
              </button>
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-md hover:bg-v2-grey-100"
                title={t("config.refresh")}
                aria-label={t("config.refresh")}
                onClick={() => void refreshEntries()}
              >
                <RefreshCw size={14} />
              </button>
            </header>
            <div className="flex min-h-0 flex-1">
              <aside className="w-[260px] shrink-0 overflow-y-auto border-r border-v2-grey-200 p-2">
                {entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-v2-grey-100 ${selectedFile === entry.path ? "bg-v2-blue-100" : ""}`}
                    onClick={() =>
                      entry.type === "directory" ? void loadEntries(selectedRoot, entry.path) : void openFile(entry)
                    }
                  >
                    <span className="truncate">{entry.name}</span>
                  </button>
                ))}
              </aside>
              <div className="flex min-w-0 flex-1 flex-col">
                {selectedFile ? (
                  <>
                    <div className="flex h-9 items-center border-b border-v2-grey-200 px-3 font-mono text-[12px] text-v2-text-text-muted">
                      {selectedFile}
                      <button
                        type="button"
                        className="ml-auto"
                        aria-label={t("config.closeEditor")}
                        onClick={() => setSelectedFile(null)}
                      >
                        <X size={14} />
                      </button>
                    </div>
                    <textarea
                      aria-label={t("config.editor")}
                      className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[12px] leading-[1.5] outline-none"
                      value={content}
                      onChange={(e) => {
                        setContent(e.target.value);
                        setSaved(false);
                      }}
                      spellCheck={false}
                    />
                    <div className="flex items-center gap-2 border-t border-v2-grey-200 p-2">
                      <button
                        type="button"
                        className="flex h-7 items-center gap-1 rounded-md bg-v2-grey-1100 px-3 text-[12px] text-v2-grey-50"
                        onClick={() => void save()}
                      >
                        <Save size={13} />
                        {t("config.save")}
                      </button>
                      {saved && (
                        <span className="text-[12px] text-v2-text-text-muted">
                          {t(savedMessage(selectedRoot, selectedFile))}
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="flex flex-1 items-center justify-center text-[13px] text-v2-text-text-faint">
                    {t("config.selectFile")}
                  </p>
                )}
                {error && (
                  <p role="alert" className="border-t border-v2-grey-200 px-3 py-2 text-[12px] text-v2-status-error">
                    {error}
                  </p>
                )}
              </div>
            </div>
          </section>
        )}
      </div>
      {dialog && (
        <ConfigCreateDialog
          kind={dialog}
          name={name}
          onNameChange={setName}
          onCreate={() => void create()}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function ConfigCreateDialog({
  kind,
  name,
  onNameChange,
  onCreate,
  onCancel,
}: {
  kind: "file" | "directory";
  name: string;
  onNameChange: (value: string) => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const { zIndex, dialogProps } = useModalLayer(onCancel, dialogRef);
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/30 p-4" style={{ zIndex }}>
      <div
        ref={dialogRef}
        role="dialog"
        {...dialogProps}
        aria-label={kind === "file" ? t("config.newFile") : t("config.newFolder")}
        className="w-full max-w-[380px] rounded-[10px] bg-v2-background-bg-base p-4 shadow-[var(--v2-elevation-overlay)]"
      >
        <h2 className="mb-3 text-[13px] font-semibold">
          {kind === "file" ? t("config.newFile") : t("config.newFolder")}
        </h2>
        <input
          aria-label={kind === "file" ? t("config.newFile") : t("config.newFolder")}
          className="h-8 w-full rounded-md border border-v2-grey-200 px-2 font-mono text-[12px]"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onCreate()}
        />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="px-3 py-1 text-[12px]" onClick={onCancel}>
            {t("config.cancel")}
          </button>
          <button
            type="button"
            className="rounded-md bg-v2-grey-1100 px-3 py-1 text-[12px] text-v2-grey-50"
            onClick={onCreate}
          >
            {t("config.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
