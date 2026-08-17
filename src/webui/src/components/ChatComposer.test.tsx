import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { ChatComposer } from "./ChatComposer";

const commands = [
  { name: "arxiv", description: "arXiv metadata", source: "skill" as const },
  { name: "drawio", description: "Diagrams", source: "skill" as const },
  { name: "name", description: "Set the session display name", source: "extension" as const },
];

async function renderComposer(props: Partial<React.ComponentProps<typeof ChatComposer>> = {}) {
  const user = userEvent.setup();
  const utils = render(
    <PreferencesProvider>
      <I18nProvider>
        <ChatComposer
          disabled={false}
          streaming={false}
          onSend={() => {}}
          onAbort={() => {}}
          commands={commands}
          {...props}
        />
      </I18nProvider>
    </PreferencesProvider>,
  );
  return { user, ...utils };
}

describe("ChatComposer slash popover", () => {
  it("opens on a leading slash and lists skill commands", async () => {
    const { user } = await renderComposer();
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("/");
    expect(await screen.findByText("/arxiv")).toBeTruthy();
    expect(screen.getByText("/drawio")).toBeTruthy();
  });

  it("does not open when the slash is not at the line start", async () => {
    const { user } = await renderComposer();
    const input = screen.getByLabelText(/message/i);
    await user.click(input);
    await user.keyboard("help /");
    expect(screen.queryByText("/arxiv")).toBeNull();
  });

  it("filters as the query grows", async () => {
    const { user } = await renderComposer();
    const input = screen.getByLabelText(/message/i);
    await user.click(input);
    await user.keyboard("/dr");
    expect(screen.queryByText("/arxiv")).toBeNull();
    expect(screen.getByText("/drawio")).toBeTruthy();
  });

  it("inserts /skill:name on Enter and closes", async () => {
    const { user } = await renderComposer();
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("/ar");
    await user.keyboard("{Enter}");
    expect(input.value).toBe("/skill:arxiv ");
    expect(screen.queryByText("/arxiv")).toBeNull();
  });

  it("inserts /name for extension commands on Enter", async () => {
    const { user } = await renderComposer();
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("/nam");
    await user.keyboard("{Enter}");
    expect(input.value).toBe("/name ");
  });

  it("navigates with ArrowDown and escapes", async () => {
    const { user } = await renderComposer();
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("/");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(input.value).toBe("/skill:drawio ");
  });

  it("does not open when commands are empty", async () => {
    const { user } = await renderComposer({ commands: [] });
    const input = screen.getByLabelText(/message/i);
    await user.click(input);
    await user.keyboard("/");
    expect(screen.queryByText("/arxiv")).toBeNull();
  });

  it("sends a plain message through onSend unchanged", async () => {
    const onSend = vi.fn();
    const { user } = await renderComposer({ onSend });
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("write a summary");
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("write a summary");
  });
});
