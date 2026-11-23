import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { getSkillMarketSummary } from "../../api/skill-marketplace";
import { useMarketSummaries } from "./useMarketSummaries";

vi.mock("../../api/skill-marketplace", () => ({ getSkillMarketSummary: vi.fn() }));
beforeEach(() => {
  vi.mocked(getSkillMarketSummary).mockReset();
});

it("bounds concurrency, shares repeated ids and aborts the view-owned queue", async () => {
  const reads = Array.from({ length: 8 }, () => Promise.withResolvers<string>());
  vi.mocked(getSkillMarketSummary).mockImplementation((id) => {
    const pending = reads[Number(id)];
    if (!pending) throw new Error(`Unexpected summary identity: ${id}`);
    return pending.promise;
  });
  const view = renderHook(({ active }) => useMarketSummaries(active), { initialProps: { active: true } });
  act(() => {
    for (let id = 0; id < 8; id++) view.result.current.requestSummary(String(id));
    view.result.current.requestSummary("0");
  });
  expect(getSkillMarketSummary).toHaveBeenCalledTimes(3);
  await act(async () => reads[0]!.resolve("First description"));
  await waitFor(() => expect(getSkillMarketSummary).toHaveBeenCalledTimes(4));
  expect(view.result.current.summaries["0"]).toBe("First description");
  act(() => view.result.current.requestSummary("0"));
  expect(getSkillMarketSummary).toHaveBeenCalledTimes(4);
  view.rerender({ active: false });
  expect(vi.mocked(getSkillMarketSummary).mock.calls.every((call) => call[1]?.aborted)).toBe(true);
  await act(async () => {
    for (const pending of reads) pending.resolve("Obsolete");
  });
  expect(view.result.current.summaries).toEqual({ "0": "First description" });
  expect(getSkillMarketSummary).toHaveBeenCalledTimes(4);
});

it("keeps an unavailable description independent from the other cards", async () => {
  vi.mocked(getSkillMarketSummary).mockRejectedValueOnce(new Error("offline")).mockResolvedValue("Available summary");
  const view = renderHook(() => useMarketSummaries(true));
  act(() => {
    view.result.current.requestSummary("failed");
    view.result.current.requestSummary("available");
  });
  await waitFor(() => expect(view.result.current.summaries.available).toBe("Available summary"));
  expect(view.result.current.summaries.failed).toBe("");
});
