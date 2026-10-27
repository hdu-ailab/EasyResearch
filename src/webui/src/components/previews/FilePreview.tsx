import type { FileContentDto } from "../../../../web/contracts";
import { useI18n } from "../../i18n/useI18n";
import { DocxPreview } from "./DocxPreview";
import { HtmlPreview } from "./HtmlPreview";
import { ImagePreview } from "./ImagePreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { PdfPreview } from "./PdfPreview";
import { PreviewToolbar } from "./PreviewToolbar";
import { previewKind } from "./preview-kind";
import { VideoPreview } from "./VideoPreview";

export interface FilePreviewProps {
  path: string;
  revision?: number;
  textFile: FileContentDto | null;
  onOpenFile: (path: string) => void;
}

/**
 * Content-aware viewers own their native/raw resources; HTML owns an isolated scope.
 * Markdown uses GFM/math with safe links, and other files use read-only text.
 * Binary files show a stable notice; truncated text and Markdown show a banner.
 */
export function FilePreview({ path, revision = 0, textFile, onOpenFile }: FilePreviewProps) {
  const { t } = useI18n();
  const kind = previewKind(path);
  if (kind === "pdf") return <PdfPreview path={path} revision={revision} />;
  if (kind === "docx") return <DocxPreview path={path} revision={revision} />;
  if (kind === "image") return <ImagePreview path={path} revision={revision} />;
  if (kind === "video") return <VideoPreview path={path} revision={revision} />;
  if (kind === "html") return <HtmlPreview path={path} revision={revision} />;
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <PreviewToolbar path={path} />
      {!textFile ? (
        <p className="p-3 text-[12px] text-v2-text-text-faint">{t("files.loading")}</p>
      ) : kind === "markdown" && !textFile.binary ? (
        <>
          {textFile.truncated && (
            <p className="shrink-0 border-b border-v2-grey-200 bg-v2-status-warning/10 px-3 py-1 text-[12px] text-v2-status-warning">
              {t("preview.truncated")}
            </p>
          )}
          <MarkdownPreview path={path} content={textFile.content} onOpenFile={onOpenFile} />
        </>
      ) : (
        <TextFilePreview textFile={textFile} />
      )}
    </div>
  );
}

function TextFilePreview({ textFile }: { textFile: FileContentDto }) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
