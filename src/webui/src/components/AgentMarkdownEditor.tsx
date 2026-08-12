import type { AgentResourceDto } from "../../../web/contracts";
import { useI18n } from "../i18n/useI18n";
import { MarkdownEditorModal } from "./MarkdownEditorModal";

export interface AgentMarkdownEditorProps {
  resource: AgentResourceDto;
  busy?: boolean;
  onSave: (content: string) => void | Promise<void>;
  onClose: () => void;
}

export function AgentMarkdownEditor({ resource, busy = false, onSave, onClose }: AgentMarkdownEditorProps) {
  const { t } = useI18n();
  return (
    <MarkdownEditorModal
      title={resource.name}
      filePath={resource.filePath}
      content={resource.content ?? ""}
      saveLabel={t("settings.agents.saveAgent")}
      busy={busy}
      onSave={onSave}
      onClose={onClose}
      editorLabel={t("settings.agents.agentMarkdown")}
    />
  );
}
