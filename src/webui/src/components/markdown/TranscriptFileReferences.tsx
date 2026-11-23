import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileLineRange } from "../../../../web/file-reference-contracts";
import { resolveFileReferences } from "../../api";
import { isAbsoluteFilesystemPath } from "../../filesystem-path";
import { useModalLayer } from "../../hooks/useModalLayer";
import { useI18n } from "../../i18n/useI18n";
import { useViewActivity, useViewActivityRef } from "../../view-activity";
import { FileReferenceBatch } from "./file-reference-batch";
import { isNetworkFileReference, resolveTranscriptFilePath } from "./file-references";
import { FileReferenceResolutionContext, TranscriptFileContext } from "./TranscriptFileLink";

interface Choice {
  paths: string[];
  truncated: boolean;
  selection?: FileLineRange;
  error?: boolean;
}

function FileReferenceChooser({
  choice,
  onSelect,
  onClose,
}: {
  choice: Choice;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const { zIndex, dialogProps } = useModalLayer(onClose, ref);
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/30 p-4" style={{ zIndex }}>
      <div
        ref={ref}
        role="dialog"
        {...dialogProps}
        aria-label={t("files.reference.choose")}
        className="max-h-[80dvh] w-full max-w-xl overflow-auto overscroll-contain rounded-lg border border-v2-grey-200 bg-v2-background-bg-base p-4 text-v2-text-text-base shadow-[var(--v2-elevation-overlay)]"
      >
        <h2 className="mb-3 text-sm font-semibold">{t("files.reference.choose")}</h2>
        {choice.error ? <p role="alert">{t("files.reference.failed")}</p> : null}
        {choice.truncated ? <p className="mb-3 text-sm">{t("files.reference.incomplete")}</p> : null}
        <ul className="space-y-1">
          {choice.paths.map((path) => (
            <li key={path}>
              <button
                type="button"
                className="w-full break-all rounded px-3 py-2 text-left font-mono text-xs hover:bg-v2-grey-100 focus-visible:outline-2"
                onClick={() => onSelect(path)}
              >
                {path}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="mt-3 rounded px-3 py-2 text-sm hover:bg-v2-grey-100" onClick={onClose}>
          {t("dialog.close")}
        </button>
      </div>
    </div>
  );
}

/** Presentation owner only: all root/child links open the same root FileBrowser. */
export function TranscriptFileReferences({
  sessionId,
  cwd,
  revision,
  onOpen,
  children,
}: {
  sessionId: string;
  cwd: string;
  revision: number | string;
  onOpen: (path: string, selection?: FileLineRange) => void;
  children: ReactNode;
}) {
  const { visible } = useViewActivity();
  const activity = useViewActivityRef();
  // Scope identity fences completions during render; effects own resources, including StrictMode replay.
  const owner = useMemo(() => ({ visible, sessionId, cwd, revision }), [visible, sessionId, cwd, revision]);
  const [owned, setOwned] = useState<{ owner: typeof owner; batch: FileReferenceBatch } | null>(null);
  const batch = owned?.owner === owner ? owned.batch : null;
  useLayoutEffect(() => {
    if (!owner.visible || !owner.sessionId || !owner.cwd) return;
    const next = new FileReferenceBatch((paths, signal) => resolveFileReferences(owner.sessionId, paths, signal));
    setOwned({ owner, batch: next });
    return () => next.dispose();
  }, [owner]);
  const currentBatch = useRef(batch);
  currentBatch.current = batch;
  const request = useRef(0);
  const requestRelease = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    void batch;
    return () => {
      requestRelease.current?.();
      requestRelease.current = null;
    };
  }, [batch]);
  const [choice, setChoice] = useState<{ batch: FileReferenceBatch; value: Choice } | null>(null);
  const close = useCallback(() => {
    requestRelease.current?.();
    requestRelease.current = null;
    request.current++;
    setChoice(null);
  }, []);
  const open = useCallback(
    (reference: string, selection?: FileLineRange) => {
      if (!activity.current.interactive) return;
      const literal = resolveTranscriptFilePath(cwd, reference, true);
      if (!literal) return;
      const token = ++request.current;
      requestRelease.current?.();
      requestRelease.current = null;
      setChoice(null);
      if (isAbsoluteFilesystemPath(reference) || isNetworkFileReference(reference)) {
        onOpen(literal, selection);
        return;
      }
      if (!batch) return;
      const current = () => request.current === token && currentBatch.current === batch && activity.current.interactive;
      const lease = batch.acquire(reference);
      requestRelease.current = lease.release;
      void lease.promise
        .then((result) => {
          if (!current()) return;
          if (result.truncated || result.paths.length > 1) {
            setChoice({ batch, value: { paths: result.paths, truncated: result.truncated, selection } });
          } else onOpen(result.paths[0] ?? literal, selection);
        })
        .catch((error: unknown) => {
          if (current() && !(error instanceof Error && error.name === "AbortError"))
            setChoice({ batch, value: { paths: [], truncated: false, error: true } });
        })
        .finally(() => {
          lease.release();
          if (requestRelease.current === lease.release) requestRelease.current = null;
        });
    },
    [batch, cwd, onOpen, activity],
  );
  return (
    <FileReferenceResolutionContext value={batch}>
      <TranscriptFileContext value={open}>
        {children}
        {visible && choice?.batch === batch ? (
          <FileReferenceChooser
            choice={choice.value}
            onClose={close}
            onSelect={(path) => {
              if (!activity.current.interactive) return;
              onOpen(path, choice.value.selection);
              close();
            }}
          />
        ) : null}
      </TranscriptFileContext>
    </FileReferenceResolutionContext>
  );
}
