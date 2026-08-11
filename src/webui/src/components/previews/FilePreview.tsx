import type { FileContentDto } from "../../../../web/contracts";
import { useI18n } from "../../i18n/useI18n";
import { MarkdownPreview } from "./MarkdownPreview";
import { PdfPreview } from "./PdfPreview";

export interface FilePreviewProps {
  path: string;
  textFile: FileContentDto | null;
  onOpenFile: (path: string) => void;
}

const PDF_RE = /\.pdf$/i;
const MARKDOWN_RE = /\.(md|markdown)$/i;

/**
 * Content-aware file preview: PDF for `.pdf`, Markdown for `.md`/`.markdown`
 * (GFM + math, safe local/external links), and read-only preformatted text for
 * everything else. Binary files show a stable notice instead of content;
 * truncated files (including Markdown) show a truncation banner.
 */
export function FilePreview({ path, textFile, onOpenFile }: FilePreviewProps) {
  const { t } = useI18n();
  if (PDF_RE.test(path)) return <PdfPreview path={path} />;
  if (!textFile) return <p className="p-3 text-[12px] text-v2-text-text-faint">{t("files.loading")}</p>;
  if (MARKDOWN_RE.test(path) && !textFile.binary) {
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
