import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilePreview } from "./FilePreview";

const faces: { family: string; bytes: ArrayBuffer; resolve: () => void; reject: () => void }[] = [];
const installed = new Set<unknown>();
beforeEach(() => {
  faces.length = 0;
  installed.clear();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(
        async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "font/woff2" } }),
      ),
  );
  vi.stubGlobal(
    "FontFace",
    class {
      family: string;
      bytes: ArrayBuffer;
      resolve!: () => void;
      reject!: () => void;
      promise: Promise<this>;
      constructor(family: string, bytes: ArrayBuffer) {
        this.family = family;
        this.bytes = bytes;
        this.promise = new Promise((resolve, reject) => {
          this.resolve = () => resolve(this);
          this.reject = () => reject(new Error("bad font"));
        });
        faces.push(this);
      }
      load() {
        return this.promise;
      }
    },
  );
  vi.stubGlobal("FontFaceSet", Set);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { add: (face: unknown) => installed.add(face), delete: (face: unknown) => installed.delete(face) },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("bounded font preview", () => {
  it("constructs distinct font faces across previews and retries without secure-context crypto", async () => {
    vi.stubGlobal("crypto", { randomUUID: undefined });
    const user = userEvent.setup();
    const first = render(<FilePreview path="/p/first.ttf" textFile={null} onOpenFile={() => {}} />);
    render(<FilePreview path="/p/second.ttf" textFile={null} onOpenFile={() => {}} />);
    await waitFor(() => expect(faces).toHaveLength(2));
    await act(async () => {
      faces[0]!.resolve();
      faces[1]!.resolve();
    });
    expect(screen.getAllByLabelText("Font preview")).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(within(first.container).getByRole("button", { name: "Retry font" }));
    await waitFor(() => expect(faces).toHaveLength(3));
    expect(installed.has(faces[0])).toBe(false);
    await act(async () => faces[2]!.resolve());
    const families = faces.map((face) => face.family);
    expect(new Set(families).size).toBe(3);
    expect(families.every((family) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(family))).toBe(true);
    expect(within(first.container).getByLabelText("Font preview")).toHaveStyle({ fontFamily: faces[2]!.family });
    expect(installed.size).toBe(2);
  });

  it("loads bytes through the raw API, installs a private font and releases it on unmount", async () => {
    const { unmount } = render(<FilePreview path="/p/type.woff2" textFile={null} onOpenFile={() => {}} />);
    await waitFor(() => expect(faces).toHaveLength(1));
    expect(faces[0]!.bytes.byteLength).toBe(3);
    expect(fetch).toHaveBeenCalledWith(
      "/api/file/raw?path=%2Fp%2Ftype.woff2",
      expect.objectContaining({ signal: expect.any(AbortSignal), method: "GET" }),
    );
    await act(async () => faces[0]!.resolve());
    expect(installed.has(faces[0])).toBe(true);
    const preview = screen.getByLabelText("Font preview");
    expect(preview).toHaveStyle({ fontFamily: faces[0]!.family, fontSize: "24px" });
    fireEvent.change(screen.getByLabelText("Sample size"), { target: { value: "64" } });
    expect(preview).toHaveStyle({ fontSize: "64px" });
    unmount();
    expect(installed.size).toBe(0);
  });

  it("never installs a stale font after revision or unmount", async () => {
    const props = { path: "/p/type.ttf", textFile: null, onOpenFile() {} };
    const { rerender, unmount } = render(<FilePreview {...props} revision={0} />);
    await waitFor(() => expect(faces).toHaveLength(1));
    rerender(<FilePreview {...props} revision={1} />);
    await waitFor(() => expect(faces).toHaveLength(2));
    await act(async () => faces[0]!.resolve());
    expect(installed.size).toBe(0);
    unmount();
    await act(async () => faces[1]!.resolve());
    expect(installed.size).toBe(0);
  });

  it("retains download on decode error and retries with a fresh face", async () => {
    const user = userEvent.setup();
    render(<FilePreview path="/p/type.otf" textFile={null} onOpenFile={() => {}} />);
    await waitFor(() => expect(faces).toHaveLength(1));
    await act(async () => faces[0]!.reject());
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByRole("link", { name: "Download font" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry font" }));
    await waitFor(() => expect(faces).toHaveLength(2));
    await act(async () => faces[1]!.resolve());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(installed.size).toBe(1);
  });

  it("rejects oversized responses before font decoding", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("", { headers: { "Content-Length": "999999999" } }));
    render(<FilePreview path="/p/type.woff" textFile={null} onOpenFile={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/preview limit/);
    expect(faces).toHaveLength(0);
  });
});
