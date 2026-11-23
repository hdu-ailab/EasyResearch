import { FileText } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { FileLineRange } from "../../../../web/file-reference-contracts";
import type { FileReferenceBatch } from "./file-reference-batch";

export const TranscriptFileContext = createContext<((reference: string, selection?: FileLineRange) => void) | null>(
  null,
);
export const FileReferenceResolutionContext = createContext<FileReferenceBatch | null>(null);
export const FileReferenceSettledContext = createContext(true);

export function TranscriptFileLink({
  children,
  "data-file-path": path,
  "data-file-automatic": automatic,
  "data-file-line-start": start,
  "data-file-line-end": end,
  href,
}: {
  children?: ReactNode;
  "data-file-path"?: string;
  "data-file-automatic"?: string;
  "data-file-line-start"?: number | string;
  "data-file-line-end"?: number | string;
  href?: string;
}) {
  const openFile = useContext(TranscriptFileContext);
  const batch = useContext(FileReferenceResolutionContext);
  const settled = useContext(FileReferenceSettledContext);
  const [verified, setVerified] = useState<{ batch: FileReferenceBatch; path: string } | null>(null);
  useEffect(() => {
    if (!batch || !path || automatic !== "true" || !settled) return;
    let active = true;
    const lease = batch.acquire(path);
    void lease.promise
      .then((result) => {
        if (active && result.paths.length) setVerified({ batch, path });
      })
      .catch(() => {});
    return () => {
      active = false;
      lease.release();
    };
  }, [batch, path, automatic, settled]);
  if (!path && href && /^https?:\/\//iu.test(href))
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  if (!openFile || !path || (automatic === "true" && (!settled || verified?.batch !== batch || verified.path !== path)))
    return <span>{children}</span>;
  const first = Number(start);
  const last = Number(end);
  const selection =
    Number.isInteger(first) && Number.isInteger(last) && first > 0 && last >= first && last <= 1_000_000
      ? { start: first, end: last }
      : undefined;
  return (
    <button
      type="button"
      className="er-file-reference cursor-pointer rounded-sm text-left text-inherit underline decoration-current/50 underline-offset-2 hover:decoration-current"
      title={path}
      onClick={() => (selection ? openFile(path, selection) : openFile(path))}
    >
      <FileText size={12} className="mr-1 inline-block align-[-2px] text-v2-text-text-faint" aria-hidden />
      {children}
    </button>
  );
}
