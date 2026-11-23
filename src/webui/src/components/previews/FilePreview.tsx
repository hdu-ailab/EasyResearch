import { lazy, Suspense } from "react";
import type { FileContentDto } from "../../../../web/contracts";
import type { FileLineRange } from "../../../../web/file-reference-contracts";
import { useI18n } from "../../i18n/useI18n";
import { MermaidDiagram } from "../MermaidDiagram";
import { AudioPreview } from "./AudioPreview";
import { DocxPreview } from "./DocxPreview";
import { FontPreview } from "./FontPreview";
import { HtmlPreview } from "./HtmlPreview";
import { ImagePreview } from "./ImagePreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { PdfPreview } from "./PdfPreview";
import { PreviewModeButtons, usePreviewMode } from "./PreviewMode";
import { PreviewToolbar } from "./PreviewToolbar";
import { previewKind } from "./preview-kind";
import { TablePreview } from "./TablePreview";
import { TextSourcePreview } from "./TextSourcePreview";
import { VideoPreview } from "./VideoPreview";

const OfficePreview = lazy(() => import("./OfficePreview").then((module) => ({ default: module.OfficePreview })));

export interface FilePreviewProps {
  path: string;
  revision?: number;
  textFile: FileContentDto | null;
  onOpenFile: (path: string, selection?: FileLineRange) => void;
  selection?: FileLineRange;
  selectionKey?: number;
}

/**
 * Content-aware viewers own their native/raw resources; HTML owns an isolated scope.
 * Markdown uses GFM/math with safe links, and other files use read-only text.
 * Binary files show a stable notice; truncated text and Markdown show a banner.
 */
export function FilePreview(props: FilePreviewProps) {
  return <FileDocument key={JSON.stringify([props.path, props.revision ?? 0])} {...props} />;
}

function FileDocument({ path, revision = 0, textFile, onOpenFile, selection, selectionKey }: FilePreviewProps) {
  const { t } = useI18n();
  const [mode, setMode] = usePreviewMode(selection, selectionKey);
  const kind = previewKind(path);
  if (kind === "pdf") return <PdfPreview path={path} revision={revision} />;
  if (kind === "docx") return <DocxPreview path={path} revision={revision} />;
  if (kind === "image") return <ImagePreview path={path} revision={revision} />;
  if (kind === "audio") return <AudioPreview path={path} revision={revision} />;
  if (kind === "font") return <FontPreview path={path} revision={revision} />;
  if (kind === "video") return <VideoPreview path={path} revision={revision} />;
  if (kind === "html")
    return <HtmlPreview path={path} revision={revision} selection={selection} selectionKey={selectionKey} />;
  if (kind === "spreadsheet" || kind === "presentation")
    return (
      <Suspense
        fallback={
          <div className="flex h-full min-w-0 flex-col">
            <PreviewToolbar path={path} />
            <p className="p-3 text-[12px] text-v2-text-text-muted">{t("files.loading")}</p>
          </div>
        }
      >
        <OfficePreview kind={kind} path={path} revision={revision} />
      </Suspense>
    );
  const toggle = kind !== "text" && <PreviewModeButtons mode={mode} onChange={setMode} />;
  const source = textFile ? (
    <TextSourcePreview content={textFile.content} selection={selection} selectionKey={selectionKey} />
  ) : (
    <p className="p-3 text-[12px] text-v2-text-text-faint">{t("files.loading")}</p>
  );
  const notice = (
    <>
      {textFile?.binary && (
        <p className="shrink-0 border-b border-v2-grey-200 bg-v2-status-warning/10 px-3 py-1 text-[12px] text-v2-status-warning">
          {t("preview.binary")}
        </p>
      )}
      {textFile?.truncated && (
        <p className="shrink-0 border-b border-v2-grey-200 bg-v2-status-warning/10 px-3 py-1 text-[12px] text-v2-status-warning">
          {t("preview.truncated")}
        </p>
      )}
    </>
  );
  if (kind === "svg")
    return (
      <ImagePreview
        path={path}
        revision={revision}
        toolbarControls={toggle}
        source={mode === "source" ? source : undefined}
        notice={notice}
      />
    );
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <PreviewToolbar path={path} controlsLabel={t("preview.mode.controls")}>
        {toggle}
      </PreviewToolbar>
      {notice}
      {!textFile || textFile.binary || mode === "source" || kind === "text" ? (
        source
      ) : kind === "markdown" ? (
        <MarkdownPreview path={path} content={textFile.content} onOpenFile={onOpenFile} />
      ) : kind === "table" ? (
        <TablePreview path={path} content={textFile.content} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <MermaidDiagram key={textFile.content} source={textFile.content} />
        </div>
      )}
    </div>
  );
}
