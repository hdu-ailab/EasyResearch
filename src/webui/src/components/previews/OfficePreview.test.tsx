import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRawFileBytes } from "../../api";
import { ViewActivityProvider } from "../../view-activity";
import { OfficePreview } from "./OfficePreview";
import { createOfficeClient, type OfficeClient, OfficePreviewError, type OfficeWorkerPort } from "./office-client";
import { createOfficePainter } from "./office-paint";
import type { OfficeFrame, OfficeView, SheetFrame } from "./office-protocol";

vi.mock("../../api", () => ({
  readRawFileBytes: vi.fn(),
  downloadFileUrl: (path: string) => `/download?path=${encodeURIComponent(path)}`,
  RawFileSizeError: class extends Error {},
}));
vi.mock("./office-client", async (original) => ({
  ...(await original<typeof import("./office-client")>()),
  createOfficeClient: vi.fn(),
}));
vi.mock("./office-paint", () => ({ createOfficePainter: vi.fn() }));

function sheet(view: OfficeView): SheetFrame {
  return {
    kind: "spreadsheet",
    list: { width: 640, height: 480, commands: [] },
    fonts: [],
    cells: [[`Sheet ${view.index + 1}, row ${view.row + 1}`, "42.50"]],
    text: `Sheet ${view.index + 1}, row ${view.row + 1}\t42.50`,
    truncated: false,
    row: view.row,
    column: view.column,
    lastRow: view.row + 24,
    lastColumn: view.column + 9,
    rowCount: 100,
    columnCount: 20,
  };
}
function fakeClient(): OfficeClient {
  return {
    open: vi.fn(async (kind) => ({
      kind,
      items: [
        { index: 0, name: "First" },
        { index: 1, name: "Second" },
      ],
    })),
    frame: vi.fn(async (view) => sheet(view)),
    dispose: vi.fn(),
  };
}
let clients: OfficeClient[];
let painters: ReturnType<typeof createOfficePainter>[];
beforeEach(() => {
  clients = [];
  painters = [];
  vi.stubGlobal("Worker", class {});
  vi.mocked(readRawFileBytes).mockResolvedValue(new ArrayBuffer(12));
  vi.mocked(createOfficeClient).mockImplementation(() => {
    const client = fakeClient();
    clients.push(client);
    return client;
  });
  vi.mocked(createOfficePainter).mockImplementation(() => {
    const painter = { paint: vi.fn(async () => ({ visual: true, omittedImages: false })), dispose: vi.fn() };
    painters.push(painter);
    return painter;
  });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("OfficePreview", () => {
  it("keeps Retry reachable after a real Worker timeout followed by Next slide, then recovers with a new owner", async () => {
    const actual = await vi.importActual<typeof import("./office-client")>("./office-client");
    const worker: OfficeWorkerPort = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      terminate: vi.fn(),
      postMessage: vi.fn((request) => {
        if (request.type === "open")
          queueMicrotask(() =>
            worker.onmessage?.({
              data: {
                id: request.id,
                type: "opened",
                document: {
                  kind: "presentation",
                  items: [
                    { index: 0, name: "1" },
                    { index: 1, name: "2" },
                  ],
                },
              },
            } as MessageEvent),
          );
        // Frame requests intentionally never reply: exercise the real owner's deadline.
      }),
    };
    vi.mocked(createOfficeClient).mockReturnValueOnce(actual.createOfficeClient(worker, 25));
    render(<OfficePreview path="/work/deck.pptx" kind="presentation" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Preview timed out");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Next slide" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Preview timed out");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("img", { name: /selectable content/ });
    expect(createOfficeClient).toHaveBeenCalledTimes(2);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("loads bounded bytes, changes sheets and pages, and exposes selectable values and download", async () => {
    const user = userEvent.setup();
    render(<OfficePreview path="/work/book.xlsx" kind="spreadsheet" />);
    await screen.findByRole("img", { name: /selectable content/ });
    expect(readRawFileBytes).toHaveBeenCalledWith("/work/book.xlsx", {
      maxBytes: 64 * 1024 * 1024,
      signal: expect.any(AbortSignal),
    });
    expect(screen.getByRole("link", { name: "Download file" })).toHaveAttribute(
      "href",
      "/download?path=%2Fwork%2Fbook.xlsx",
    );
    await user.selectOptions(screen.getByLabelText("Sheet"), "1");
    await waitFor(() =>
      expect(clients[0]!.frame).toHaveBeenLastCalledWith({ index: 1, row: 0, column: 0 }, expect.any(AbortSignal)),
    );
    await user.click(screen.getByRole("button", { name: "Next rows" }));
    await waitFor(() =>
      expect(clients[0]!.frame).toHaveBeenLastCalledWith({ index: 1, row: 25, column: 0 }, expect.any(AbortSignal)),
    );
    await user.click(screen.getByText("Selectable text"));
    const table = screen.getByRole("table");
    expect(within(table).getByRole("cell", { name: "42.50" })).toBeVisible();
    expect(within(table).getByRole("cell", { name: "Sheet 2, row 26" })).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    const paintCount = vi.mocked(painters[0]!.paint).mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("125%")).toBeVisible();
    expect(painters[0]!.paint).toHaveBeenCalledTimes(paintCount + 1);
    expect(readRawFileBytes).toHaveBeenCalledOnce();
  });

  it("terminates file/revision owners and ignores an obsolete frame", async () => {
    let late: ((frame: OfficeFrame) => void) | undefined;
    const first = fakeClient();
    vi.mocked(first.frame).mockImplementation(
      () =>
        new Promise((resolve) => {
          late = resolve;
        }),
    );
    vi.mocked(createOfficeClient).mockReturnValueOnce(first);
    const view = render(<OfficePreview path="/work/book.xlsx" kind="spreadsheet" revision={0} />);
    await waitFor(() => expect(first.frame).toHaveBeenCalledOnce());
    const signal = vi.mocked(first.frame).mock.calls[0]![1];
    view.rerender(<OfficePreview path="/work/book.xlsx" kind="spreadsheet" revision={1} />);
    await screen.findByRole("img", { name: /selectable content/ });
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(true);
    await act(async () => late?.({ ...sheet({ index: 0, row: 0, column: 0 }), text: "obsolete" }));
    expect(screen.queryByText("obsolete")).not.toBeInTheDocument();
    view.unmount();
    expect(clients[0]!.dispose).toHaveBeenCalledOnce();
    expect(painters.every((painter) => vi.mocked(painter.dispose).mock.calls.length === 1)).toBe(true);
  });

  it("releases a hidden retained view and opens it again without sending frame before open", async () => {
    const content = (visible: boolean) => (
      <ViewActivityProvider visible={visible} interactive={visible}>
        <OfficePreview path="/work/book.xlsx" kind="spreadsheet" />
      </ViewActivityProvider>
    );
    const view = render(content(true));
    await screen.findByRole("img", { name: /selectable content/ });
    view.rerender(content(false));
    expect(clients[0]!.dispose).toHaveBeenCalledOnce();
    view.rerender(content(true));
    await waitFor(() => expect(clients[1]?.frame).toHaveBeenCalledOnce());
    expect(vi.mocked(clients[1]!.open).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(clients[1]!.frame).mock.invocationCallOrder[0]!,
    );
  });

  it("keeps slide text and notes when canvas is unavailable", async () => {
    const slide = fakeClient();
    vi.mocked(slide.frame).mockResolvedValue({
      kind: "presentation",
      list: { contractVersion: 2, width: 960, height: 540, primitives: [] },
      text: "Actual slide words",
      notes: "Speaker details",
      images: [],
      fonts: [],
      omittedImages: false,
      truncated: false,
    });
    vi.mocked(createOfficeClient).mockReturnValueOnce(slide);
    vi.mocked(createOfficePainter).mockReturnValueOnce({
      paint: vi.fn(async () => ({ visual: false, omittedImages: false })),
      dispose: vi.fn(),
    });
    render(<OfficePreview path="/work/deck.pptx" kind="presentation" />);
    expect(await screen.findByText(/Canvas rendering is unavailable/)).toBeVisible();
    expect(screen.getByText("Actual slide words")).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByText("Speaker notes"));
    expect(screen.getByText("Speaker details")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Next slide" }));
    await waitFor(() =>
      expect(slide.frame).toHaveBeenLastCalledWith({ index: 1, row: 0, column: 0 }, expect.any(AbortSignal)),
    );
  });

  it("provides recovery from a Worker timeout with a new owner", async () => {
    const first = fakeClient();
    vi.mocked(first.open).mockRejectedValue(new OfficePreviewError("timeout"));
    vi.mocked(createOfficeClient).mockReturnValueOnce(first);
    render(<OfficePreview path="/work/book.xlsx" kind="spreadsheet" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Preview timed out");
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("img", { name: /selectable content/ });
    expect(createOfficeClient).toHaveBeenCalledTimes(2);
  });
});
