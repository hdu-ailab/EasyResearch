import { render, screen } from "@testing-library/react";
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
};
const dualProvider: AuthProviderInfoDto = {
  id: "xai",
  name: "xAI",
  authMethods: ["api_key", "oauth"],
  connectable: true,
  authStatus: { configured: false },
};
const ambientProvider: AuthProviderInfoDto = {
  id: "google-vertex",
  name: "Google Vertex AI",
  authMethods: ["api_key"],
  connectable: false,
  authStatus: { configured: false },
  hint: "ambient creds",
};

function makeFlow(overrides: Partial<UseProviderAuthFlow> = {}): UseProviderAuthFlow {
  return {
    providers: [apiKeyProvider, dualProvider, ambientProvider],
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
  it("renders the provider list with status dots and ambient hint", () => {
    mockedUse.mockReturnValue(makeFlow());
    render(<ProviderConnectModal onClose={() => {}} />);
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("xAI")).toBeInTheDocument();
    expect(screen.getByText("Google Vertex AI")).toBeInTheDocument();
    expect(screen.getByText("ambient creds")).toBeInTheDocument();
  });

  it("starts immediately for a single-method provider", async () => {
    const flow = makeFlow();
    mockedUse.mockReturnValue(flow);
    const user = userEvent.setup();
    render(<ProviderConnectModal onClose={() => {}} />);
    await user.click(screen.getAllByText("Connect")[0]!);
    expect(flow.start).toHaveBeenCalledWith("anthropic", "api_key");
  });

  it("shows a method picker for a dual-method provider", async () => {
    const flow = makeFlow();
    mockedUse.mockReturnValue(flow);
    const user = userEvent.setup();
    render(<ProviderConnectModal onClose={() => {}} />);
    await user.click(screen.getAllByText("Connect")[1]!);
    expect(flow.start).not.toHaveBeenCalled();
    expect(screen.getByText("Use an API key")).toBeInTheDocument();
    expect(screen.getByText("Use subscription")).toBeInTheDocument();
  });

  it("calls disconnect for a connected provider", async () => {
    const flow = makeFlow({
      providers: [{ ...apiKeyProvider, authStatus: { configured: true } }, dualProvider, ambientProvider],
    });
    mockedUse.mockReturnValue(flow);
    const user = userEvent.setup();
    render(<ProviderConnectModal onClose={() => {}} />);
    await user.click(screen.getByText("Disconnect"));
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
});
