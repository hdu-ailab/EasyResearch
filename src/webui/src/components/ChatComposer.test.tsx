import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

describe("ChatComposer single running-state button (ADR-083)", () => {
  it("sends while streaming whenever the input has content", async () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();
    const { user } = await renderComposer({ streaming: true, onSend, onAbort });
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("steer note");
    expect(screen.getByLabelText(/send/i)).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("steer note");
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("stops the run while streaming when the input is empty", async () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();
    const { user } = await renderComposer({ streaming: true, onSend, onAbort });
    const stop = screen.getByLabelText(/stop/i);
    await user.click(stop);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps focus in the textarea after sending", async () => {
    const onSend = vi.fn();
    const { user } = await renderComposer({ onSend });
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("hello");
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("hello");
    expect(input).toHaveFocus();
  });

  it("keeps focus in the textarea after stopping the run", async () => {
    const { user } = await renderComposer({ streaming: true });
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    const stop = screen.getByLabelText(/stop/i);
    await user.click(stop);
    expect(input).toHaveFocus();
  });

  it("restores focus once the composer re-enables after a disabling send cycle", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [busy, setBusy] = useState(false);
      return (
        <ChatComposer
          disabled={busy}
          streaming={false}
          commands={[]}
          onAbort={() => {}}
          onSend={() => {
            setBusy(true);
            setTimeout(() => setBusy(false), 0);
          }}
        />
      );
    }
    render(
      <PreferencesProvider>
        <I18nProvider>
          <Harness />
        </I18nProvider>
      </PreferencesProvider>,
    );
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("hello");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(input).toHaveFocus());
  });
});
