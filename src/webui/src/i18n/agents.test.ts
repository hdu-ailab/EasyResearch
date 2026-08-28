import { describe, expect, it } from "vitest";
import { agentDescription, agentDisplayName, type Translate } from "./agents";
import { messages } from "./messages";

describe("agentDisplayName", () => {
  const en = ((key: keyof typeof messages.en) => messages.en[key]) as Translate;
  const zh = ((key: keyof typeof messages.en) => messages["zh-CN"][key]) as Translate;

  it("localizes known roster agent ids in both languages", () => {
    expect(agentDisplayName(en, "research-assistant")).toBe("Research Assistant");
    expect(agentDisplayName(en, "search")).toBe("Search");
    expect(agentDisplayName(zh, "research-assistant")).toBe("研究助手");
    expect(agentDisplayName(zh, "search")).toBe("检索");
    expect(agentDisplayName(zh, "experiment")).toBe("实验");
    expect(agentDisplayName(zh, "writing")).toBe("写作");
    expect(agentDisplayName(zh, "figures")).toBe("图表");
    expect(agentDisplayName(en, "review")).toBe("Review");
    expect(agentDisplayName(zh, "review")).toBe("审稿");
  });

  it("matches the label casing agents arrive in", () => {
    expect(agentDisplayName(en, "Research-Assistant")).toBe("Research Assistant");
    expect(agentDisplayName(zh, "Search")).toBe("检索");
  });

  it("falls back to the raw id for unknown agents", () => {
    expect(agentDisplayName(en, "assistant")).toBe("assistant");
    expect(agentDisplayName(en, "mystery-agent")).toBe("mystery-agent");
  });
});

describe("agentDescription", () => {
  const en = (key: keyof typeof messages.en) => messages.en[key] as string;
  const zh = (key: keyof typeof messages.en) => messages["zh-CN"][key] as string;

  it("localizes known roster descriptions in both languages", () => {
    expect(agentDescription(en, "research-assistant", "ignored")).toBe(messages.en["agentDesc.researchAssistant"]);
    expect(agentDescription(zh, "research-assistant", "ignored")).toBe(
      messages["zh-CN"]["agentDesc.researchAssistant"],
    );
    expect(agentDescription(zh, "search", "ignored")).toBe(messages["zh-CN"]["agentDesc.search"]);
    expect(agentDescription(zh, "experiment", "ignored")).toBe(messages["zh-CN"]["agentDesc.experiment"]);
    expect(agentDescription(zh, "writing", "ignored")).toBe(messages["zh-CN"]["agentDesc.writing"]);
    expect(agentDescription(zh, "figures", "ignored")).toBe(messages["zh-CN"]["agentDesc.figures"]);
    expect(agentDescription(zh, "review", "ignored")).toBe(messages["zh-CN"]["agentDesc.review"]);
  });

  it("matches the casing agents arrive in", () => {
    expect(agentDescription(en, "Research-Assistant", "ignored")).toBe(messages.en["agentDesc.researchAssistant"]);
  });

  it("falls back to the registry text for unknown agents", () => {
    expect(agentDescription(en, "mystery-agent", "raw text")).toBe("raw text");
  });

  it("keeps every localized description nonempty", () => {
    const ids = ["research-assistant", "search", "experiment", "writing", "figures", "review"];
    for (const id of ids) {
      for (const lang of [en, zh]) {
        expect(agentDescription(lang, id, "")).not.toBe("");
      }
    }
  });
});
