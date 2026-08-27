import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AuthProviderInfoDto } from "../../../web/contracts";
import { type UseProviderAuthFlow, useProviderAuthFlow } from "../hooks/useProviderAuthFlow";
import { ProviderConnectModal } from "./ProviderConnectModal";

vi.mock("../hooks/useProviderAuthFlow", () => ({
  useProviderAuthFlow: vi.fn(),
}));

const mockedUse = vi.mocked(useProviderAuthFlow);

const apiKeyProvider: AuthProviderInfoDto = {
  id: "anthropic",
  name: "Anthropic",
  authMethods: ["api_key"],
  connectable: true,
  authStatus: { configured: false },
  modelsJson: false,
};
const dualProvider: AuthProviderInfoDto = {
  id: "xai",
  name: "xAI",
  authMethods: ["api_key", "oauth"],
  connectable: true,
  authStatus: { configured: false },
  modelsJson: false,
};
const ambientProvider: AuthProviderInfoDto = {
  id: "google-vertex",
  name: "Google Vertex AI",
  authMethods: ["api_key"],
  connectable: false,
  authStatus: { configured: false },
  hint: "ambient creds",
  modelsJson: false,
};

function makeFlow(overrides: Partial<UseProviderAuthFlow> = {}): UseProviderAuthFlow {
  return {
    providers: [apiKeyProvider, dualProvider, ambientProvider],
    providersLoaded: true,
    connectedCount: 0,
    view: "idle",
    pendingPrompt: null,
    notifies: [],
    warning: undefined,
    errorMessage: undefined,
    errorReason: undefined,
    activeProviderId: undefined,
    start: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    backToList: vi.fn(),
    logout: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("ProviderConnectModal", () => {
  it("uses the full mobile viewport and keeps its desktop bounds at 820px", () => {
    mockedUse.mockReturnValue(makeFlow());
    render(<ProviderConnectModal onClose={() => {}} />);

    const dialog = screen.getByRole("dialog", { name: "Connect providers" });
    expect(dialog.parentElement).toHaveClass("p-0", "min-[820px]:p-6");
    expect(dialog).toHaveClass(
      "h-full",
      "w-full",
      "min-[820px]:h-auto",
      "min-[820px]:max-h-[min(720px,calc(100vh-24px))]",
      "min-[820px]:max-w-[720px]",
      "min-[820px]:rounded-[10px]",
    );
    expect(dialog).not.toHaveClass("max-h-[min(720px,calc(100vh-24px))]", "max-w-[720px]", "rounded-[10px]");
  });

  it("renders the provider list with status dots and ambient hint", async () => {
    mockedUse.mockReturnValue(makeFlow());
    const user = userEvent.setup();
    render(<ProviderConnectModal onClose={() => {}} />);
    expect(screen.getByRole("searchbox")).toHaveFocus();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("xAI")).toBeInTheDocument();
    expect(screen.getByText("Google Vertex AI")).toBeInTheDocument();
    expect(screen.getByText("Ambient-only: configure via environment or config file.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Google Vertex AI/ }));
    expect(screen.getByText("ambient creds")).toBeInTheDocument();
  });

  it("starts immediately for a single-method provider", async () => {
    const flow = makeFlow();
    mockedUse.mockReturnValue(flow);
    const user = userEvent.setup();
    render(<ProviderConnectModal onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Anthropic" }));
    expect(flow.start).toHaveBeenCalledWith("anthropic", "api_key");
  });

  it("shows a method picker in the connection view for a dual-method provider", async () => {
    const flow = makeFlow();
    mockedUse.mockReturnValue(flow);
    const user = userEvent.setup();
    render(<ProviderConnectModal onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "xAI" }));
    expect(flow.start).not.toHaveBeenCalled();
    expect(screen.getByText("Use an API key")).toBeInTheDocument();
    expect(screen.getByText("Use subscription")).toBeInTheDocument();
    await user.click(screen.getByText("Use subscription"));
    expect(flow.start).toHaveBeenCalledWith("xai", "oauth");
  });

  it("disconnects a configured provider from its connection view", async () => {
    const flow = makeFlow({
      providers: [{ ...apiKeyProvider, authStatus: { configured: true } }, dualProvider, ambientProvider],
    });
    mockedUse.mockReturnValue(flow);
    const user = userEvent.setup();
    render(<ProviderConnectModal onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Anthropic" }));
    expect(flow.start).not.toHaveBeenCalled();
    await user.click(screen.getByText("Disconnect Anthropic"));
    expect(flow.logout).toHaveBeenCalledWith("anthropic");
  });

  it("renders an auth_url notify with a link and a device_code with the code", () => {
    mockedUse.mockReturnValue(
      makeFlow({
        view: "flow",
        notifies: [
          { kind: "auth_url", url: "https://x/authorize" },
          { kind: "device_code", userCode: "ABCD-1234", verificationUri: "https://x/device" },
        ],
      }),
    );
    render(<ProviderConnectModal onClose={() => {}} />);
    expect(screen.getByText("https://x/authorize")).toBeInTheDocument();
    expect(screen.getByText("ABCD-1234")).toBeInTheDocument();
  });

  it("renders info notify links as external anchors", () => {
    mockedUse.mockReturnValue(
      makeFlow({
        view: "flow",
        notifies: [
          {
            kind: "info",
            message: "Visit the docs",
            links: [{ url: "https://x/docs", label: "Documentation" }, { url: "https://x/guide" }],
          },
        ],
      }),
    );
    render(<ProviderConnectModal onClose={() => {}} />);
    expect(screen.getByText("Visit the docs")).toBeInTheDocument();
    const docs = screen.getByText("Documentation");
    expect(docs.tagName).toBe("A");
    expect(docs).toHaveAttribute("href", "https://x/docs");
    expect(screen.getByText("https://x/guide")).toHaveAttribute("href", "https://x/guide");
  });

  it("renders a device_code countdown from expiresInSeconds", () => {
    vi.useFakeTimers();
    try {
      mockedUse.mockReturnValue(
        makeFlow({
          view: "flow",
          notifies: [
            { kind: "device_code", userCode: "ABCD", verificationUri: "https://x/device", expiresInSeconds: 60 },
          ],
        }),
      );
      render(<ProviderConnectModal onClose={() => {}} />);
      expect(screen.getByText(/Expires in 60s/)).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.getByText(/Expires in 57s/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a secret prompt and submits its value", async () => {
    const flow = makeFlow({
      view: "flow",
      pendingPrompt: { kind: "secret", message: "API key" },
    });
    mockedUse.mockReturnValue(flow);
    const user = userEvent.setup();
    render(<ProviderConnectModal onClose={() => {}} />);
    const input = screen.getByDisplayValue("") as HTMLInputElement;
    await user.type(input, "sk-abc");
    await user.click(screen.getByText("Submit"));
    expect(flow.respond).toHaveBeenCalledWith("sk-abc");
  });

  it("shows a warning sub-card on done", () => {
    mockedUse.mockReturnValue(
      makeFlow({ view: "done", warning: "Credential saved; models may not refresh until restart." }),
    );
    render(<ProviderConnectModal onClose={() => {}} />);
    expect(screen.getByText("Credential saved; models may not refresh until restart.")).toBeInTheDocument();
  });

  it("shows an error message", () => {
    mockedUse.mockReturnValue(makeFlow({ view: "error", errorMessage: "provider rejected", errorReason: "reject" }));
    render(<ProviderConnectModal onClose={() => {}} />);
    expect(screen.getByText("provider rejected")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it("renders a provider logo for known providers and the synthetic fallback for unknown ones", () => {
    mockedUse.mockReturnValue(
      makeFlow({
        providers: [
          { ...apiKeyProvider, id: "anthropic" },
          { ...dualProvider, id: "custom-local" },
        ],
      }),
    );
    render(<ProviderConnectModal onClose={() => {}} />);
    const known = document.querySelector('[data-component="provider-icon"] use');
    expect(known?.getAttribute("href")).toMatch(/#anthropic$/);
    const icons = document.querySelectorAll('[data-component="provider-icon"] use');
    expect(icons[1]?.getAttribute("href")).toMatch(/#synthetic$/);
  });

  it("filters providers by name and shows the no-results message", async () => {
    const user = userEvent.setup();
    mockedUse.mockReturnValue(makeFlow());
    render(<ProviderConnectModal onClose={() => {}} />);
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("xAI")).toBeInTheDocument();

    const search = screen.getByRole("searchbox");
    await user.type(search, "anthrop");
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.queryByText("xAI")).toBeNull();

    await user.clear(search);
    await user.type(search, "nonexistent-provider");
    expect(screen.getByText("No providers match your search.")).toBeInTheDocument();
  });

  it("navigates the filtered list with ArrowDown/ArrowUp and connects with Enter", async () => {
    const flow = makeFlow();
    mockedUse.mockReturnValue(flow);
    const user = userEvent.setup();
    render(<ProviderConnectModal onClose={() => {}} />);

    const search = screen.getByRole("searchbox");
    await user.click(search);
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "Anthropic" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "xAI" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("button", { name: "Anthropic" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(flow.start).toHaveBeenCalledWith("anthropic", "api_key");
  });
});
