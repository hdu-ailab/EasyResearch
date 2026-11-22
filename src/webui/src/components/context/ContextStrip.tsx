import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ContextItemType } from "../../../../web/context-contracts";
import { useI18n } from "../../i18n/useI18n";

export interface ContextBlock {
  id: string;
  type: ContextItemType;
  label: string;
  preview: string;
  tokens: number;
  percent: number;
  width: number;
  change?: "fold" | "delete" | "mixed";
}
const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const SELECTOR_PAGE_SIZE = 50;
export const contextNumber = (value: number | null) => (value === null ? "—" : numberFormat.format(value));
export const contextShare = (value: number) => `${contextNumber(value)}%`;

interface PreviewInterest {
  block: ContextBlock;
  trigger: HTMLButtonElement;
  source: "focus" | "pointer";
}

/** Anchor to the visible part of the trigger, including nested scroll clipping. */
function previewPosition({ trigger }: PreviewInterest) {
  const rect = trigger.getBoundingClientRect();
  let left = Math.max(0, rect.left);
  let right = Math.min(window.innerWidth, rect.right);
  let top = Math.max(0, rect.top);
  let bottom = Math.min(window.innerHeight, rect.bottom);
  for (let parent = trigger.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
    const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
    if (!clipsX && !clipsY) continue;
    const bounds = parent.getBoundingClientRect();
    if (clipsX) {
      left = Math.max(left, bounds.left);
      right = Math.min(right, bounds.right);
    }
    if (clipsY) {
      top = Math.max(top, bounds.top);
      bottom = Math.min(bottom, bounds.bottom);
    }
  }
  return {
    visible:
      trigger.isConnected &&
      !trigger.closest('[hidden], [inert], [aria-hidden="true"]') &&
      right > left &&
      bottom > top,
    left: Math.max(12, Math.min(left, window.innerWidth - 332)),
    top: bottom + 8,
    anchorTop: top,
  };
}

/** Fixed snapshot widths: pending edits only add an outline and a status label. */
export function ContextStrip({
  label,
  blocks,
  selected,
  onSelect,
  chips = false,
}: {
  label: string;
  blocks: ContextBlock[];
  selected?: string;
  onSelect(id: string): void;
  chips?: boolean;
}) {
  const { t } = useI18n();
  const tooltipId = useId();
  const selectorId = useId();
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [requestedPage, setPage] = useState(0);
  const lastPage = Math.max(0, Math.ceil(blocks.length / SELECTOR_PAGE_SIZE) - 1);
  const page = Math.min(requestedPage, lastPage);
  const offset = page * SELECTOR_PAGE_SIZE;
  const tooltip = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<(PreviewInterest & ReturnType<typeof previewPosition>) | null>(null);
  useLayoutEffect(() => {
    if (!hover?.visible || !tooltip.current) return;
    const height = tooltip.current.getBoundingClientRect().height;
    if (hover.top + height > window.innerHeight - 12) {
      const top = Math.max(12, hover.anchorTop - height - 8);
      if (top !== hover.top) setHover({ ...hover, top });
    }
  }, [hover]);
  useLayoutEffect(() => {
    if (!hover) return;
    const reposition = () => {
      if (hover.source !== "focus" || document.activeElement !== hover.trigger) {
        setHover(null);
        return;
      }
      setHover({ ...hover, ...previewPosition(hover) });
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [hover]);
  const show = (block: ContextBlock, trigger: HTMLButtonElement, source: PreviewInterest["source"]) => {
    const interest = { block, trigger, source };
    setHover({ ...interest, ...previewPosition(interest) });
  };
  const button = (block: ContextBlock, chip: boolean) => (
    <button
      type="button"
      key={block.id}
      className={chip ? "context-chip" : "context-block"}
      data-type={block.type}
      data-change={block.change}
      aria-pressed={selected === block.id}
      aria-label={`${block.label} · ${contextNumber(block.tokens)} tokens · ${contextShare(block.percent)}`}
      aria-describedby={
        hover?.visible &&
        hover.block.id === block.id &&
        hover.trigger.classList.contains(chip ? "context-chip" : "context-block")
          ? tooltipId
          : undefined
      }
      style={chip ? undefined : { flexGrow: block.width }}
      onPointerEnter={(event) =>
        show(block, event.currentTarget, document.activeElement === event.currentTarget ? "focus" : "pointer")
      }
      onPointerLeave={() => {
        if (hover?.source !== "focus") setHover(null);
      }}
      onFocus={(event) => show(block, event.currentTarget, "focus")}
      onBlur={() => setHover(null)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && hover?.visible) {
          event.stopPropagation();
          setHover(null);
        }
      }}
      onClick={() => {
        setHover(null);
        if (!chip) setPage(Math.floor(blocks.indexOf(block) / SELECTOR_PAGE_SIZE));
        onSelect(block.id);
      }}
    >
      <span className="context-block-content">
        <span className="context-block-label">{block.label}</span>
        <span className="context-block-metrics">
          {contextNumber(block.tokens)}
          <span className="context-token-unit"> tokens</span> · {contextShare(block.percent)}
        </span>
      </span>
      {block.change ? (
        <span className="context-change-label">
          {t(
            block.change === "mixed"
              ? "context.pendingMixed"
              : block.change === "fold"
                ? "context.pendingFold"
                : "context.pendingDelete",
          )}
        </span>
      ) : null}
    </button>
  );
  const selector = () => (
    <fieldset
      id={selectorId}
      className="context-selector-content"
      aria-label={t(chips ? "context.selectMessage" : "context.selectSegment")}
    >
      <div className="context-chips">
        {blocks.slice(offset, offset + SELECTOR_PAGE_SIZE).map((block) => button(block, true))}
      </div>
      {lastPage > 0 ? (
        <div className="context-selector-pages">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => {
              setHover(null);
              setPage(page - 1);
            }}
          >
            {t("studio.previous")}
          </button>
          <span aria-live="polite">
            {t("context.selectorRange")
              .replace("{start}", String(offset + 1))
              .replace("{end}", String(Math.min(offset + SELECTOR_PAGE_SIZE, blocks.length)))
              .replace("{total}", String(blocks.length))}
          </span>
          <button
            type="button"
            disabled={page === lastPage}
            onClick={() => {
              setHover(null);
              setPage(page + 1);
            }}
          >
            {t("studio.next")}
          </button>
        </div>
      ) : null}
    </fieldset>
  );
  return (
    <>
      <fieldset className="context-strip" aria-label={label}>
        {blocks.map((block) => button(block, false))}
      </fieldset>
      {chips ? (
        selector()
      ) : (
        <div className="context-selector">
          <button
            type="button"
            aria-expanded={selectorOpen}
            aria-controls={selectorOpen ? selectorId : undefined}
            onClick={() => {
              setHover(null);
              setSelectorOpen((open) => !open);
            }}
          >
            {t("context.selectSegment")}
          </button>
          {selectorOpen ? selector() : null}
        </div>
      )}
      {hover?.visible ? (
        <div
          ref={tooltip}
          role="tooltip"
          id={tooltipId}
          className="context-tooltip"
          style={{ left: hover.left, top: hover.top }}
        >
          <strong>{hover.block.label}</strong>
          <p>{hover.block.preview}</p>
          <span>
            {contextNumber(hover.block.tokens)} tokens ·{" "}
            {t("context.totalShare").replace("{share}", contextShare(hover.block.percent))}
          </span>
        </div>
      ) : null}
    </>
  );
}
