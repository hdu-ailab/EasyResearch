import { useEffect } from "react";
import { ShieldCheck, X } from "lucide-react";

export interface TrustDialogProps {
  options: Array<{ label: string; trusted: boolean; savesDecision: boolean }>;
  onApply: (optionIndex: number) => void;
  onCancel: () => void;
}

/**
 * Modal trust decision overlay. Emits the exact native option index; the
 * backend maps it to Pi's decision semantics. Escape and backdrop click
 * cancel without making any trust call.
 */
export function TrustDialog({ options, onApply, onCancel }: TrustDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="trust-overlay" role="presentation" onClick={onCancel}>
      <div
        className="trust-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Project trust decision"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="trust-dialog__header">
          <ShieldCheck size={18} />
          <h2>Trust this project?</h2>
          <button className="icon-button" aria-label="Cancel" title="Cancel" onClick={onCancel}>
            <X size={16} />
          </button>
        </header>
        <p className="trust-dialog__hint">
          The project asks to run agent tools and access local resources.
        </p>
        <ul className="trust-dialog__options">
          {options.map((option, index) => (
            <li key={option.label}>
              <button type="button" className="trust-dialog__option" onClick={() => onApply(index)}>
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
