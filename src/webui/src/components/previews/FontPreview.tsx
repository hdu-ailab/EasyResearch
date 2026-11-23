import { RotateCw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { RawFileSizeError, readRawFileBytes } from "../../api";
import { useI18n } from "../../i18n/useI18n";
import { PreviewToolbar, previewButtonClass } from "./PreviewToolbar";

// Presentation-only namespace: every load (including retries) owns a distinct face.
// A module sequence works on ordinary HTTP origins without secure-context crypto.
let fontFaceSequence = 0;

export function FontPreview({ path, revision = 0 }: { path: string; revision?: number }) {
  return <FontDocument key={JSON.stringify([path, revision])} path={path} />;
}

function FontDocument({ path }: { path: string }) {
  const { t } = useI18n();
  const sizeId = useId();
  const [size, setSize] = useState(24);
  const [attempt, setAttempt] = useState(0);
  const [family, setFamily] = useState<string | null>(null);
  const [failure, setFailure] = useState<"error" | "size" | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly owns a fresh request and font lifetime.
  useEffect(() => {
    const controller = new AbortController();
    let face: FontFace | undefined;
    setFamily(null);
    setFailure(null);
    const load = async () => {
      if (typeof FontFace === "undefined" || !document.fonts?.add) throw new Error("Font API unavailable");
      const bytes = await readRawFileBytes(path, { maxBytes: 16 * 1024 * 1024, signal: controller.signal });
      if (controller.signal.aborted) return;
      // Buffer source avoids object-URL lifetime and quoting issues. The family is never an authored identifier.
      face = new FontFace(`preview-font-${++fontFaceSequence}`, bytes);
      await face.load();
      if (controller.signal.aborted) return;
      document.fonts.add(face);
      setFamily(face.family);
    };
    void load().catch((error: unknown) => {
      if (!controller.signal.aborted) setFailure(error instanceof RawFileSizeError ? "size" : "error");
    });
    return () => {
      controller.abort();
      if (face) document.fonts.delete(face);
    };
  }, [path, attempt]);
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <PreviewToolbar path={path} label={t("preview.font.download")} controlsLabel={t("preview.font.controls")}>
        <label htmlFor={sizeId} className="text-[12px] text-v2-text-text-muted">
          {t("preview.font.size")}
        </label>
        <select
          id={sizeId}
          value={size}
          onChange={(event) => setSize(Number(event.target.value))}
          className="rounded border border-v2-grey-200 bg-v2-grey-50 p-1 text-[12px] text-v2-text-text-base"
        >
          {[12, 16, 24, 40, 64].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={previewButtonClass}
          aria-label={t("preview.font.retry")}
          title={t("preview.font.retry")}
          onClick={() => setAttempt((value) => value + 1)}
        >
          <RotateCw size={14} aria-hidden />
        </button>
      </PreviewToolbar>
      {family ? (
        <section
          aria-label={t("preview.font.title")}
          className="min-h-0 flex-1 space-y-6 overflow-auto break-words p-4 leading-relaxed text-v2-text-text-base"
          style={{ fontFamily: family, fontSize: size }}
        >
          <p>{t("preview.font.sample")}</p>
          <p>
            ABCDEFGHIJKLMNOPQRSTUVWXYZ
            <br />
            abcdefghijklmnopqrstuvwxyz
            <br />
            0123456789 !?&amp;@#%()&#123;&#125;[]
          </p>
        </section>
      ) : (
        <p role={failure ? "alert" : "status"} className="p-4 text-center text-[12px] text-v2-text-text-muted">
          {t(failure === "size" ? "preview.font.tooLarge" : failure ? "preview.font.loadError" : "files.loading")}
        </p>
      )}
    </div>
  );
}
