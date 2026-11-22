import { getSessionTitleSettings, patchSessionTitleSettings } from "../api";
import { BooleanConversationSetting } from "./ApiUsageDetailsSetting";

const read = async () => (await getSessionTitleSettings()).autoSessionTitle;
const write = async (autoSessionTitle: boolean) =>
  (await patchSessionTitleSettings({ autoSessionTitle })).autoSessionTitle;

export function SessionTitleSetting({ configurationGeneration }: { configurationGeneration: number }) {
  return (
    <BooleanConversationSetting
      configurationGeneration={configurationGeneration}
      read={read}
      write={write}
      labelKey="settings.conversation.autoTitle"
      hintKey="settings.conversation.autoTitleHint"
      loadErrorKey="settings.conversation.autoTitleLoadError"
      saveErrorKey="settings.conversation.autoTitleSaveError"
    />
  );
}
