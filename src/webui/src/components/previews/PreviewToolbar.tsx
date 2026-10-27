import { Download } from "lucide-react";
import type { ReactNode } from "react";
import { downloadFileUrl } from "../../api";
import { filesystemPathName } from "../../filesystem-path";
import { useI18n } from "../../i18n/useI18n";

export const previewButtonClass =
  "flex h-7 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-v2-text-text-muted transition-colors hover:bg-v2-grey-100 hover:text-v2-text-text-base disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

export function PreviewDownload({ path, label }: { path: string; label?: string }) {
  const { t } = useI18n();
  const name = label ?? t("preview.download");
  return (
    <a
      href={downloadFileUrl(path)}
      download={filesystemPathName(path)}
      aria-label={name}
      title={name}
      className={previewButtonClass}
    >
      <Download size={14} aria-hidden />
      <span className="hidden sm:inline">{name}</span>
    </a>
  );
}

export function PreviewToolbar({
  path,
  label,
  controlsLabel,
  children,
}: {
  path: string;
  label?: string;
  controlsLabel?: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-1 border-b border-v2-grey-200 px-2 py-1.5">
      {children && (
        <fieldset className="flex min-w-0 flex-wrap items-center gap-1 border-0 p-0">
          <legend className="sr-only">{controlsLabel}</legend>
          {children}
        </fieldset>
      )}
      <div className="ml-auto">
        <PreviewDownload path={path} label={label} />
      </div>
    </header>
  );
}
