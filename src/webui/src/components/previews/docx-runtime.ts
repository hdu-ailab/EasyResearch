import type { Options } from "docx-preview";
import { readRawFileBytes } from "../../api";
import { inspectDocxPackage } from "./docx-package";

export interface DocxLoader {
  load(path: string, signal: AbortSignal): Promise<ArrayBuffer>;
  render(bytes: ArrayBuffer, body: HTMLElement, styles: HTMLElement, onBlobUrl?: (url: string) => void): Promise<void>;
}

interface DocxDocument {
  blobToURL(blob: Blob, path?: string): string | Promise<string> | null;
}

export interface DocxPreviewModule {
  parseAsync(bytes: ArrayBuffer, options: Partial<Options>): Promise<DocxDocument>;
  renderDocument(document: DocxDocument, options: Partial<Options>): Promise<Node[]>;
}

export type DocxPreviewImporter = () => Promise<DocxPreviewModule>;

const MAX_RAW_BYTES = 32 * 1024 * 1024;
const PACKAGE_LIMITS = {
  maxEntries: 4_096,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
};

const RENDER_OPTIONS: Partial<Options> = {
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
};

async function importDocxPreview(): Promise<DocxPreviewModule> {
  return import("docx-preview");
}

export function createDocxLoader(importPreview: DocxPreviewImporter = importDocxPreview): DocxLoader {
  return {
    async load(path, signal) {
      const bytes = await readRawFileBytes(path, { maxBytes: MAX_RAW_BYTES, signal });
      inspectDocxPackage(bytes, PACKAGE_LIMITS);
      return bytes;
    },
    async render(bytes, body, styles, onBlobUrl) {
      const { parseAsync, renderDocument } = await importPreview();
      const document = await parseAsync(bytes, RENDER_OPTIONS);
      const blobToURL = document.blobToURL.bind(document);
      document.blobToURL = (blob, path) => {
        const url = blobToURL(blob, path);
        if (typeof url === "string" && url.startsWith("blob:")) onBlobUrl?.(url);
        return url;
      };
      const nodes = await renderDocument(document, RENDER_OPTIONS);
      styles.replaceChildren();
      body.replaceChildren();
      for (const node of nodes) {
        (node.nodeName === "STYLE" ? styles : body).append(node);
      }
    },
  };
}
