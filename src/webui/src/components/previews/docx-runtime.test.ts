import { describe, expect, it, vi } from "vitest";
import { createDocxLoader } from "./docx-runtime";

describe("createDocxLoader", () => {
  it("parses and attaches rendered nodes with layout features enabled and active content disabled", async () => {
    const documentModel = { blobToURL: vi.fn((_blob: Blob, _path?: string) => "blob:asset") };
    const style = document.createElement("style");
    const section = document.createElement("section");
    const parseAsync = vi.fn(async () => documentModel);
    const renderDocument = vi.fn(async () => [style, section]);
    const loader = createDocxLoader(async () => ({ parseAsync, renderDocument }) as never);
    const body = document.createElement("main");
    const styles = document.createElement("div");

    await loader.render(new ArrayBuffer(1), body, styles);

    expect(parseAsync).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      expect.objectContaining({
        breakPages: true,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        renderAltChunks: false,
        renderChanges: false,
        renderComments: false,
        experimental: false,
        useBase64URL: false,
      }),
    );
    expect(renderDocument).toHaveBeenCalledWith(documentModel, expect.objectContaining({ useBase64URL: false }));
    expect(styles).toContainElement(style);
    expect(body).toContainElement(section);
  });

  it("reports each Blob URL before a later render failure", async () => {
    const documentModel = { blobToURL: vi.fn((_blob: Blob, _path?: string) => "blob:detached-font") };
    const renderDocument = vi.fn(async (value: typeof documentModel) => {
      value.blobToURL(new Blob(["font"]), "word/fonts/font.odttf");
      throw new Error("malformed formula");
    });
    const loader = createDocxLoader(async () => ({ parseAsync: async () => documentModel, renderDocument }) as never);
    const onBlobUrl = vi.fn();

    await expect(
      (
        loader.render as unknown as (
          bytes: ArrayBuffer,
          body: HTMLElement,
          styles: HTMLElement,
          onBlobUrl: (url: string) => void,
        ) => Promise<void>
      )(new ArrayBuffer(1), document.createElement("main"), document.createElement("div"), onBlobUrl),
    ).rejects.toThrow("malformed formula");
    expect(onBlobUrl).toHaveBeenCalledWith("blob:detached-font");
  });
});
