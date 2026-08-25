import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiUsageStatisticsDto } from "../../../web/contracts";
import * as api from "../api";
import { I18nProvider } from "../i18n/I18nProvider";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { ApiUsageStatisticsDialog } from "./ApiUsageStatisticsDialog";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, getApiUsageStatistics: vi.fn() };
});

const totals = (tokens: number, cost: number) => ({
  records: 2,
  input: tokens - 2,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  reasoning: 0,
  totalTokens: tokens,
  cacheHitRate: 0.25,
  cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

function statistics(tokens = 15): ApiUsageStatisticsDto {
  return {
    rootSessionId: "root-1",
    total: totals(tokens, 0.3),
    sessions: [
      {
        sessionId: "root-1",
        direct: totals(5, 0.1),
        subtree: totals(tokens, 0.3),
        models: [
          {
            key: "openai/test-model",
            provider: "openai",
            model: "test-model",
            kind: "model",
            totals: totals(5, 0.1),
          },
        ],
      },
      {
        sessionId: "child-1",
        parentSessionId: "root-1",
        agent: "search",
        agentId: "search_0",
        direct: totals(10, 0.2),
        subtree: totals(10, 0.2),
        models: [{ key: "internal", kind: "internal", totals: totals(10, 0.2) }],
      },
    ],
    partial: true,
    warnings: [{ sessionId: "missing-child", agentId: "figures_0", reason: "unreadable-descendant" }],
  };
}

function renderDialog(liveStatistics?: ApiUsageStatisticsDto, onClose = vi.fn()) {
  return {
    onClose,
    ...render(
      <PreferencesProvider>
        <I18nProvider>
          <ApiUsageStatisticsDialog sessionId="root-1" liveStatistics={liveStatistics} onClose={onClose} />
        </I18nProvider>
      </PreferencesProvider>,
    ),
  };
}

describe("ApiUsageStatisticsDialog", () => {
  beforeEach(() => {
    vi.mocked(api.getApiUsageStatistics).mockReset().mockResolvedValue(statistics());
  });

  it("shows tree totals, session/model groups, and a safe partial warning", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: /api usage statistics/i });
    expect(dialog).toHaveTextContent("15 tokens");
    expect(dialog).toHaveTextContent("$0.3000");
    expect(dialog).toHaveTextContent("Cache hit 25.0%");
    expect(dialog).toHaveTextContent("search_0");
    expect(dialog).toHaveTextContent(/some mapped session usage is unavailable/i);
    expect(dialog).not.toHaveTextContent("/agent/sessions");

    await user.click(screen.getByRole("button", { name: /search_0/i }));
    expect(dialog).toHaveTextContent("Internal tools and summaries");
    expect(dialog).toHaveTextContent("10 tokens");
  });

  it("replaces loaded totals with a newer live server projection", async () => {
    const view = renderDialog();
    expect(await screen.findAllByText(/15 tokens/)).not.toHaveLength(0);

    view.rerender(
      <PreferencesProvider>
        <I18nProvider>
          <ApiUsageStatisticsDialog sessionId="root-1" liveStatistics={statistics(20)} onClose={view.onClose} />
        </I18nProvider>
      </PreferencesProvider>,
    );

    await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent("20 tokens"));
  });
});
