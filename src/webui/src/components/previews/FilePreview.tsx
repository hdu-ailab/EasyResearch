import type { FileContentDto } from "../../../../web/contracts";
import { useI18n } from "../../i18n/useI18n";
import { DocxPreview } from "./DocxPreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { PdfPreview } from "./PdfPreview";
import { previewKind } from "./preview-kind";

export interface FilePreviewProps {
  path: string;
  revision?: number;
  textFile: FileContentDto | null;
  onOpenFile: (path: string) => void;
}

/**
 * Content-aware file preview: PDF and DOCX use bounded raw-byte viewers,
 * Markdown uses GFM/math with safe links, and other files use read-only text.
 * Binary files show a stable notice; truncated text and Markdown show a banner.
 */
export function FilePreview({ path, revision = 0, textFile, onOpenFile }: FilePreviewProps) {
  const { t } = useI18n();
  const kind = previewKind(path);
  if (kind === "pdf") return <PdfPreview path={path} />;
  if (kind === "docx") return <DocxPreview path={path} revision={revision} />;
  if (!textFile) return <p className="p-3 text-[12px] text-v2-text-text-faint">{t("files.loading")}</p>;
  if (kind === "markdown" && !textFile.binary) {
    return (
      <div className="flex h-full min-w-0 flex-col">
        {textFile.truncated && (
          <p className="shrink-0 border-b border-v2-grey-200 bg-v2-status-warning/10 px-3 py-1 text-[12px] text-v2-status-warning">
            {t("preview.truncated")}
          </p>
        )}
        <MarkdownPreview path={path} content={textFile.content} onOpenFile={onOpenFile} />
      </div>
    );
  }
  return <TextFilePreview textFile={textFile} />;
}

function TextFilePreview({ textFile }: { textFile: FileContentDto }) {
  const { t } = useI18n();
  return (
    <div className="flex h-full min-w-0 flex-col">
      {textFile.binary && (
        <p className="shrink-0 border-b border-v2-grey-200 bg-v2-status-warning/10 px-3 py-1 text-[12px] text-v2-status-warning">
          {t("preview.binary")}
        </p>
      )}
      {textFile.truncated && (
        <p className="shrink-0 border-b border-v2-grey-200 bg-v2-status-warning/10 px-3 py-1 text-[12px] text-v2-status-warning">
          {t("preview.truncated")}
        </p>
      )}
      <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-[1.5] text-v2-text-text-base whitespace-pre">
        {textFile.content}
      </pre>
    </div>
  );
}
