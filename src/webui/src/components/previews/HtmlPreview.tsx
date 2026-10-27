import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  createHtmlPreview,
  type HtmlPreviewCapability,
  RawFileSizeError,
  readHtmlPreviewSource,
  releaseHtmlPreview,
} from "../../api";
import { useI18n } from "../../i18n/useI18n";
import { PreviewToolbar, previewButtonClass } from "./PreviewToolbar";

export interface HtmlPreviewProps {
  path: string;
  revision?: number;
}

export function HtmlPreview({ path, revision = 0 }: HtmlPreviewProps) {
  return <HtmlDocument key={JSON.stringify([path, revision])} path={path} revision={revision} />;
}

function HtmlDocument({ path, revision }: Required<HtmlPreviewProps>) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [attempt, setAttempt] = useState(0);
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <PreviewToolbar path={path} label={t("preview.html.download")} controlsLabel={t("preview.html.controls")}>
        {(["preview", "source"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={previewButtonClass}
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
          >
            {t(value === "preview" ? "preview.html.preview" : "preview.html.source")}
          </button>
        ))}
        <button
          type="button"
          className={previewButtonClass}
          aria-label={t("preview.html.retry")}
          title={t("preview.html.retry")}
          onClick={() => setAttempt((value) => value + 1)}
        >
          <RotateCw size={14} aria-hidden />
        </button>
      </PreviewToolbar>
      <details className="shrink-0 border-b border-v2-grey-200 px-3 py-1.5 text-[11px] text-v2-text-text-muted">
        <summary className="cursor-pointer rounded hover:text-v2-text-text-base">{t("preview.html.scope")}</summary>
        <p className="pt-1.5">{t("preview.html.limitation")}</p>
      </details>
      {mode === "preview" ? (
        <HtmlFrame key={attempt} path={path} />
      ) : (
        <HtmlSource key={attempt} path={path} revision={revision} attempt={attempt} />
      )}
    </div>
  );
}

function release(capability: HtmlPreviewCapability) {
  // Best-effort on detached views/page exit; boot-local inactivity expiry also bounds abandoned scopes.
  void releaseHtmlPreview(capability.id).catch(() => {});
}

function HtmlFrame({ path }: { path: string }) {
  const { t } = useI18n();
  const [capability, setCapability] = useState<HtmlPreviewCapability | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let owned: HtmlPreviewCapability | null = null;
    void createHtmlPreview(path).then(
      (created) => {
        if (cancelled) {
          release(created);
          return;
        }
        owned = created;
        setCapability(created);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
      if (owned) release(owned);
    };
  }, [path]);

  if (failed) return <HtmlMessage error />;
  if (!capability) return <HtmlMessage />;
  return (
    <iframe
      src={capability.url}
      title={t("preview.html.title")}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="min-h-0 w-full flex-1 border-0 bg-white"
      // A load event also fires for HTTP error documents. The scoped endpoint renders
      // those safely; the trusted toolbar always retains Retry, Source and Download.
    />
  );
}

function HtmlSource({ path, revision, attempt }: Required<HtmlPreviewProps> & { attempt: number }) {
  const [source, setSource] = useState<string | null>(null);
  const [failure, setFailure] = useState<"error" | "size" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void readHtmlPreviewSource(path, { revision, attempt, signal: controller.signal }).then(
      (text) => {
        if (!controller.signal.aborted) setSource(text);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setFailure(error instanceof RawFileSizeError ? "size" : "error");
      },
    );
    return () => controller.abort();
  }, [path, revision, attempt]);

  if (failure) return <HtmlMessage error tooLarge={failure === "size"} />;
  if (source === null) return <HtmlMessage />;
  return (
    <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-[1.5] text-v2-text-text-base whitespace-pre">
      {source}
    </pre>
  );
}

function HtmlMessage({ error = false, tooLarge = false }: { error?: boolean; tooLarge?: boolean }) {
  const { t } = useI18n();
  return (
    <p
      className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4 text-center text-[12px] text-v2-text-text-muted"
      role={error ? "alert" : "status"}
    >
      {t(tooLarge ? "preview.html.tooLarge" : error ? "preview.html.loadError" : "files.loading")}
    </p>
  );
}
