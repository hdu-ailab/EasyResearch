import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadFileUrl, HTML_SOURCE_MAX_BYTES } from "../../api";
import { FilePreview } from "./FilePreview";
import { HtmlPreview } from "./HtmlPreview";

function capability(id: string) {
  return { id, url: `/api/file/preview/${id}/report.html` };
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<Fetch>>;
let nextId: number;

beforeEach(() => {
  nextId = 0;
  fetchMock = vi.fn<Fetch>(async (_input, init) => {
    if (init?.method === "POST") return Response.json(capability(`cap-${++nextId}`));
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return new Response('<h1 id="authored-source">Source report</h1><script>unsafe()</script>');
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  cleanup();
  // Allow detached, owned DELETEs to drain before restoring the real transport.
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.unstubAllGlobals();
});

const creates = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
const reads = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "GET");
const deletes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([path]) => path);

describe("interactive HTML preview", () => {
  it("keeps folder access and supported local dependencies reachable in a native disclosure", async () => {
    const user = userEvent.setup();
    render(<HtmlPreview path="/p/report.html" />);
    await screen.findByTitle("HTML preview");
    const summary = screen.getByText("HTML access and limits");
    const limits = screen.getByText(/Reports can read their HTML folder and subfolders/);
    expect(limits).not.toBeVisible();
    await user.click(summary);
    expect(limits).toBeVisible();
    expect(limits).toHaveTextContent("local modules and fetch work");
    expect(limits).toHaveTextContent(
      "External/CDN resources, workers, storage, forms, popups and app APIs are unavailable",
    );
  });
  it("uses exactly the script-only opaque sandbox and server URL without reading or injecting HTML", async () => {
    const { unmount } = render(
      <FilePreview
        path="/p/report.HTML"
        textFile={{
          path: "/p/report.HTML",
          content: '<script id="truncated-source">unsafe()</script>',
          truncated: true,
          byteCount: 1_048_576,
          binary: false,
        }}
        onOpenFile={() => {}}
      />,
    );
    const frame = await screen.findByTitle("HTML preview");
    expect(frame).toHaveAttribute("src", capability("cap-1").url);
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame).not.toHaveAttribute("srcdoc");
    expect(document.querySelector("#truncated-source")).toBeNull();
    expect(reads()).toHaveLength(0);
    expect(screen.getAllByRole("link", { name: "Download HTML" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Download HTML" })).toHaveAttribute(
      "href",
      downloadFileUrl("/p/report.HTML"),
    );
    // A 404 document can emit load too. Retry stays available after every load.
    fireEvent.load(frame);
    expect(screen.getByRole("button", { name: "Retry HTML" })).toBeEnabled();
    unmount();
    await waitFor(() => expect(deletes()).toEqual(["/api/file/preview/cap-1"]));
  });

  it("releases the runtime for Source, renders inert complete text, and recreates on keyboard Preview", async () => {
    const user = userEvent.setup();
    render(<HtmlPreview path="/p/report.html" revision={5} />);
    await screen.findByTitle("HTML preview");
    await user.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.queryByTitle("HTML preview")).toBeNull();
    expect(await screen.findByText(/<h1 id="authored-source">/)).toBeVisible();
    expect(document.querySelector("#authored-source")).toBeNull();
    expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "true");
    expect(reads()).toHaveLength(1);
    const sourceUrl = new URL(String(reads()[0]![0]), "http://localhost");
    expect(sourceUrl.pathname).toBe("/api/file/raw");
    expect(sourceUrl.searchParams.get("revision")).toBe("5");
    await waitFor(() => expect(deletes()).toContain("/api/file/preview/cap-1"));
    screen.getByRole("button", { name: "Preview" }).focus();
    await user.keyboard("{Enter}");
    const next = await screen.findByTitle("HTML preview");
    expect(next).toHaveAttribute("src", capability("cap-2").url);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(screen.queryByText(/<h1 id="authored-source">/)).toBeNull();
  });

  it("recovers creation failure and keeps Retry available after a frame load", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Missing file" }, { status: 404 }));
    render(<HtmlPreview path="/p/report.html" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load");
    expect(screen.getByRole("link", { name: "Download HTML" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry HTML" }));
    const frame = await screen.findByTitle("HTML preview");
    fireEvent.load(frame);
    expect(screen.getByRole("button", { name: "Retry HTML" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Retry HTML" }));
    expect(await screen.findByTitle("HTML preview")).toHaveAttribute("src", capability("cap-2").url);
    await waitFor(() => expect(deletes()).toContain("/api/file/preview/cap-1"));
  });

  it("releases on watcher revision/path changes and ignores an obsolete creation", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender, unmount } = render(<HtmlPreview path="/p/report.html" revision={0} />);
    await waitFor(() => expect(creates()).toHaveLength(1));
    rerender(<HtmlPreview path="/p/report.html" revision={1} />);
    const current = await screen.findByTitle("HTML preview");
    expect(current).toHaveAttribute("src", capability("cap-1").url);
    await act(async () => {
      finish(Response.json(capability("stale-cap")));
    });
    await waitFor(() => expect(deletes()).toContain("/api/file/preview/stale-cap"));
    expect(screen.getByTitle("HTML preview")).toBe(current);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    rerender(<HtmlPreview path="/p/new.html" revision={0} />);
    await waitFor(() => expect(screen.getByTitle("HTML preview")).toHaveAttribute("src", capability("cap-2").url));
    await waitFor(() => expect(deletes()).toContain("/api/file/preview/cap-1"));
    unmount();
    await waitFor(() => expect(deletes()).toContain("/api/file/preview/cap-2"));
  });

  it.each(["unmount", "source", "retry"] as const)("releases a late creation after %s cancellation", async (action) => {
    const user = userEvent.setup();
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { unmount } = render(<HtmlPreview path="/p/report.html" />);
    await waitFor(() => expect(creates()).toHaveLength(1));
    if (action === "unmount") unmount();
    else await user.click(screen.getByRole("button", { name: action === "source" ? "Source" : "Retry HTML" }));
    expect(creates()[0]![1]?.signal).toBeUndefined();
    await act(async () => {
      finish(Response.json(capability("late-cap")));
    });
    await waitFor(() => expect(deletes().filter((path) => path === "/api/file/preview/late-cap")).toHaveLength(1));
    expect(document.querySelector('iframe[src*="late-cap"]')).toBeNull();
  });

  it("ignores old source bytes and aborts the read when switching back to Preview", async () => {
    const user = userEvent.setup();
    let finish!: (response: Response) => void;
    render(<HtmlPreview path="/p/report.html" />);
    await screen.findByTitle("HTML preview");
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) =>
      init?.method === "GET"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(input, init),
    );
    await user.click(screen.getByRole("button", { name: "Source" }));
    await waitFor(() => expect(reads()).toHaveLength(1));
    const signal = reads()[0]![1]!.signal!;
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByTitle("HTML preview");
    expect(signal.aborted).toBe(true);
    await act(async () => {
      finish(new Response("Obsolete source"));
    });
    expect(screen.queryByText("Obsolete source")).toBeNull();
  });

  it.each(["oversize", "missing"] as const)(
    "offers source retry/download for %s while streamed preview remains available",
    async (failure) => {
      const user = userEvent.setup();
      render(<HtmlPreview path="/p/report.html" />);
      await screen.findByTitle("HTML preview");
      const original = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input, init) =>
        init?.method === "GET"
          ? Promise.resolve(
              failure === "oversize"
                ? new Response("", { headers: { "Content-Length": String(HTML_SOURCE_MAX_BYTES + 1) } })
                : Response.json({ error: "Missing file" }, { status: 404 }),
            )
          : original(input, init),
      );
      await user.click(screen.getByRole("button", { name: "Source" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        failure === "oversize" ? /too large/i : /could not load/i,
      );
      if (failure === "oversize") {
        expect(screen.getByRole("alert")).toHaveTextContent("32 MiB");
        expect(screen.getByRole("alert")).toHaveTextContent("Preview and download remain available");
      }
      expect(screen.getByRole("link", { name: "Download HTML" })).toBeVisible();
      expect(screen.queryByTitle("HTML preview")).toBeNull();
      fetchMock.mockImplementation(original);
      await user.click(screen.getByRole("button", { name: "Retry HTML" }));
      expect(await screen.findByText(/<h1 id="authored-source">/)).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Preview" }));
      expect(await screen.findByTitle("HTML preview")).toBeVisible();
    },
  );
});
