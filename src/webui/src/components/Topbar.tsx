import { House } from "lucide-react";
import type { ReactNode, Ref } from "react";
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

/** Shared navigation chrome above the workspace. */
export function Topbar({ home, leading, center, actions }: TopbarProps) {
  return (
    <header className="grid min-h-[52px] shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-b border-v2-grey-200 bg-v2-background-bg-base px-[12px] py-2 min-[820px]:h-[52px] min-[820px]:grid-cols-[auto_minmax(0,1fr)_auto] min-[820px]:gap-3 min-[820px]:py-0">
      <div className="flex min-w-0 items-center gap-2 overflow-hidden">
        <ProductMark home={home} />
        {leading}
      </div>
      <div className="col-span-2 row-start-2 flex min-w-0 items-center justify-center overflow-hidden empty:hidden min-[820px]:col-span-1 min-[820px]:col-start-2 min-[820px]:row-start-1">
        {center}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-0.5 overflow-hidden">{actions}</div>
    </header>
  );
}

export function TopbarIconButton({
  active = false,
  buttonRef,
  label,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  label: string;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={`flex size-[36px] shrink-0 items-center justify-center rounded-xl transition-colors ${
        active
          ? "bg-v2-blue-100 text-v2-blue-600"
          : "text-v2-icon-icon-muted hover:bg-v2-grey-100 hover:text-v2-icon-icon-base"
      }`}
    >
      {children}
    </button>
  );
}

export function ProductMark({ home }: { home?: TopbarProps["home"] } = {}) {
  const { t } = useI18n();
  const logo = (
    <img
      src="/favicon.svg"
      width="30"
      height="30"
      alt=""
      aria-hidden="true"
      data-testid="product-logo"
      className={`shrink-0 ${home ? "transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0" : ""}`}
    />
  );

  return (
    <div className="flex items-center gap-2">
      {home ? (
        <button
          type="button"
          aria-label={t("topbar.backToHome")}
          title={t("topbar.backToHome")}
          aria-current={home.active ? "page" : undefined}
          onClick={home.onClick}
          className="group relative flex size-[36px] shrink-0 items-center justify-center rounded-xl text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100 hover:text-v2-blue-600 focus-visible:text-v2-blue-600"
        >
          {logo}
          <House
            size={17}
            data-testid="product-home-icon"
            className="absolute opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            aria-hidden
          />
        </button>
      ) : (
        logo
      )}
      <span className="text-[24px] font-bold tracking-tight" style={{ color: "#304c90" }}>
        EasyResearch
      </span>
    </div>
  );
}
