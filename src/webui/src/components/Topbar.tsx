import { House, Lightbulb } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "../i18n/useI18n";

export interface TopbarProps {
  home: {
    active: boolean;
    onClick?: () => void;
  };
  leading?: ReactNode;
  center?: ReactNode;
  actions?: ReactNode;
}

/** Global 36px top bar shared by every page. */
export function Topbar({ home, leading, center, actions }: TopbarProps) {
  const { t } = useI18n();
  const homeLabel = t("topbar.backToHome");

  return (
    <header className="grid h-[36px] shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-v2-grey-200 bg-v2-background-bg-deep px-[12px] min-[820px]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] min-[820px]:gap-3">
      <div className="flex min-w-0 items-center gap-2 overflow-hidden">
        <button
          type="button"
          aria-label={homeLabel}
          title={homeLabel}
          aria-current={home.active ? "page" : undefined}
          onClick={home.onClick}
          className={`flex size-[28px] shrink-0 items-center justify-center rounded-md transition-colors ${
            home.active
              ? "bg-v2-blue-100 text-v2-blue-600"
              : "text-v2-icon-icon-muted hover:bg-v2-grey-100 hover:text-v2-icon-icon-base"
          }`}
        >
          <House size={15} aria-hidden />
        </button>
        {leading}
      </div>
      <div className="flex min-w-0 items-center justify-center overflow-hidden">{center}</div>
      <div className="flex min-w-0 items-center justify-end gap-0.5 overflow-hidden">{actions}</div>
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
      className={`flex size-[28px] items-center justify-center rounded-md transition-colors ${
        active
          ? "bg-v2-blue-100 text-v2-blue-600"
          : "text-v2-icon-icon-muted hover:bg-v2-grey-100 hover:text-v2-icon-icon-base"
      }`}
    >
      {children}
    </button>
  );
}

export function ProductMark() {
  return (
    <div className="flex items-center gap-2">
      <Lightbulb size={16} className="text-v2-blue-600" aria-hidden />
      <span className="text-[13px] font-semibold tracking-tight text-v2-text-text-base">EasyResearch</span>
    </div>
  );
}
