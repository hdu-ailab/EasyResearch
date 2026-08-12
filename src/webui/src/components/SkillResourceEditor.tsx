import type { SkillResourceDto } from "../../../web/contracts";
import { useI18n } from "../i18n/useI18n";
import { MarkdownEditorModal } from "./MarkdownEditorModal";

export interface SkillResourceEditorProps {
  resource: SkillResourceDto;
  busy?: boolean;
  onSave: (content: string) => void | Promise<void>;
  onClose: () => void;
}

export function SkillResourceEditor({ resource, busy = false, onSave, onClose }: SkillResourceEditorProps) {
  const { t } = useI18n();
  return (
    <MarkdownEditorModal
      title={resource.name}
      filePath={resource.skillPath}
      content={resource.content ?? ""}
      saveLabel={t("settings.agents.saveSkill")}
      busy={busy}
      onSave={onSave}
      onClose={onClose}
      editorLabel={t("settings.agents.skillMarkdown")}
    />
  );
}
