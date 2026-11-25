import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SkillResourceDto } from "../../../../web/contracts";
import { useModalLayer } from "../../hooks/useModalLayer";
import { useI18n } from "../../i18n/useI18n";
import { PanelHeading, SkillDiagnosticsPanel, type SkillDiagnosticsPanelProps } from "./SettingsPanels";
import { SkillActionMenu } from "./SkillActionMenu";
import { classifySkill, type SkillCategory, skillCategories } from "./skill-categories";
import "./skills-settings.css";

export function SkillsSettingsPanel({
  skills,
  active,
  onEdit,
  onToggle,
  onDelete,
  ...diagnostics
}: SkillDiagnosticsPanelProps & {
  skills: readonly SkillResourceDto[];
  active: boolean;
  onEdit(name: string): Promise<void>;
  onToggle(skill: SkillResourceDto): Promise<void>;
  onDelete(skill: SkillResourceDto): Promise<void>;
}) {
  const { t } = useI18n();
  const [category, setCategory] = useState<SkillCategory>("all");
  const [deleting, setDeleting] = useState<SkillResourceDto | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, { message: string; retry(): void } | undefined>>(new Map());
  const busy = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const perform = async (skill: SkillResourceDto, action: () => Promise<void>, after?: () => void) => {
    if (busy.current.has(skill.name)) return;
    busy.current.add(skill.name);
    setPending(new Set(busy.current));
    setErrors((current) => new Map(current).set(skill.name, undefined));
    try {
      await action();
      if (mounted.current) after?.();
    } catch (cause) {
      if (mounted.current)
        setErrors((current) =>
          new Map(current).set(skill.name, {
            message: cause instanceof Error ? cause.message : String(cause),
            retry: () => void perform(skill, action, after),
          }),
        );
    } finally {
      busy.current.delete(skill.name);
      if (mounted.current) setPending(new Set(busy.current));
    }
  };
  const rows = skills.filter((skill) => category === "all" || classifySkill(skill) === category);
  return (
    <div className="er-skills">
      <PanelHeading>{t("settings.category.skills")}</PanelHeading>
      <fieldset className="er-skill-categories">
        <legend className="sr-only">{t("skills.categories")}</legend>
        {skillCategories.map((value) => (
          <button key={value} type="button" aria-pressed={value === category} onClick={() => setCategory(value)}>
            {t(`skills.category.${value}`)}
          </button>
        ))}
      </fieldset>
      <div className="er-skill-grid">
        {rows.map((skill) => (
          <article
            key={skill.name}
            data-skill-name={skill.name}
            className="er-skill-card"
            aria-busy={pending.has(skill.name)}
          >
            <header>
              <h3>{skill.name}</h3>
              <SkillActionMenu
                name={skill.name}
                enabled={skill.enabled !== false}
                canDelete={skill.canDelete === true}
                busy={pending.has(skill.name)}
                active={active}
                onEdit={() => void perform(skill, () => onEdit(skill.name))}
                onToggle={() => void perform(skill, () => onToggle(skill))}
                onDelete={() => setDeleting(skill)}
              />
            </header>
            <div className="er-skill-source">
              <span>{t(`skills.source.${skill.source}`)}</span>
              {skill.enabled === false && <span>{t("skills.disabled")}</span>}
            </div>
            <p className="er-skill-description" title={skill.description || undefined}>
              {skill.description ?? ""}
            </p>
            {errors.get(skill.name) && (
              <div className="er-market-error" role="alert">
                <span>{errors.get(skill.name)?.message}</span>
                <button type="button" disabled={pending.has(skill.name)} onClick={errors.get(skill.name)?.retry}>
                  {t("dialog.retry")}
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      {rows.length === 0 && <p className="er-market-empty">{t("skills.noMatches")}</p>}
      <SkillDiagnosticsPanel {...diagnostics} />
      {deleting && active && (
        <DeleteSkillDialog
          skill={deleting}
          busy={pending.has(deleting.name)}
          error={errors.get(deleting.name)?.message}
          onCancel={() => {
            if (!busy.current.has(deleting.name)) setDeleting(null);
          }}
          onConfirm={() =>
            void perform(
              deleting,
              () => onDelete(deleting),
              () => setDeleting(null),
            )
          }
        />
      )}
    </div>
  );
}

function DeleteSkillDialog({
  skill,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  skill: SkillResourceDto;
  busy: boolean;
  error?: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const layer = useModalLayer(onCancel, ref);
  return createPortal(
    <div className="er-market-detail-overlay" style={{ zIndex: layer.zIndex }}>
      <div
        ref={ref}
        role="dialog"
        {...layer.dialogProps}
        aria-label={t("skills.deleteTitle").replace("{name}", skill.name)}
        className="er-skill-delete-dialog"
      >
        <h2>{t("skills.deleteTitle").replace("{name}", skill.name)}</h2>
        <p>{t("skills.deleteDescription")}</p>
        {error && (
          <p role="alert" className="er-skill-error">
            {error}
          </p>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={onCancel}>
            {t("config.cancel")}
          </button>
          <button type="button" disabled={busy} onClick={onConfirm}>
            {busy ? t("dialog.loading") : t("studio.delete")}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
