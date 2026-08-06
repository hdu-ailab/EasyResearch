import type { ReactNode } from "react";
import { useI18n } from "../i18n/useI18n";

export interface TopbarProps {
  leading?: ReactNode;
  center?: ReactNode;
  actions?: ReactNode;
}

/**
 * Global 36px top bar shared by every page (opencode titlebar pattern:
 * grid-cols-[1fr_auto_1fr], bg-deep surface).
 */
export function Topbar({ leading, center, actions }: TopbarProps) {
  return (
    <header className="grid h-9 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-v2-grey-200 bg-v2-background-bg-deep px-3">
      <div className="flex min-w-0 items-center gap-2">{leading}</div>
      <div className="flex min-w-0 items-center justify-center truncate">{center}</div>
      <div className="flex min-w-0 items-center justify-end gap-0.5">{actions}</div>
    </header>
  );
}

export function TopbarIconButton({
  active = false,
  label,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  label: string;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={`flex size-7 items-center justify-center rounded-md transition-colors ${
        active
          ? "bg-v2-blue-100 text-v2-blue-600"
          : "text-v2-icon-icon-muted hover:bg-v2-grey-100 hover:text-v2-icon-icon-base"
      }`}
    >
      {children}
    </button>
  );
}

export function BackButton({ onClick, label }: { onClick: () => void; label?: string }) {
  const { t } = useI18n();
  const resolved = label ?? t("topbar.backToHome");
  return (
    <button
      type="button"
      aria-label={resolved}
      title={resolved}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100 hover:text-v2-icon-icon-base"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M19 12H5" />
        <path d="M12 19l-7-7 7-7" />
      </svg>
    </button>
  );
}

export function ProductMark() {
  return (
    <div className="flex items-center gap-2">
      <span className="size-4 rounded-[4px] bg-v2-blue-600" aria-hidden />
      <span className="text-[13px] font-semibold tracking-tight text-v2-text-text-base">LazyResearch</span>
    </div>
  );
}
