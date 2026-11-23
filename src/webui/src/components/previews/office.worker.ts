import { DocxPackageError } from "./docx-package";
import { officeAssetUrl, officeFontUrl } from "./office-assets";
import { type OfficeEngine, openOfficeEngine } from "./office-engine";
import type { OfficeReply, OfficeRequest } from "./office-protocol";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<OfficeRequest>) => void) | null;
  postMessage(reply: OfficeReply): void;
};
let engine: OfficeEngine | undefined;
let busy = false;

scope.onmessage = (event) => {
  const request = event.data;
  if (busy) {
    scope.postMessage({ id: request.id, type: "error", code: "busy" });
    return;
  }
  busy = true;
  void (async () => {
    try {
      if (request.type === "open") {
        if (engine) throw new Error("opened");
        engine = await openOfficeEngine(
          request.kind,
          request.bytes,
          {
            wasm: officeAssetUrl(request.kind),
            async font(face) {
              const asset = officeFontUrl(face.file);
              if (!asset) throw new Error("font");
              const url = new URL(asset, globalThis.location.href);
              if (url.origin !== globalThis.location.origin) throw new Error("font");
              const response = await fetch(url, { redirect: "error", credentials: "same-origin" });
              if (!response.ok || face.byteLength > 8 * 1024 * 1024) throw new Error("font");
              const bytes = new Uint8Array(await response.arrayBuffer());
              if (bytes.byteLength !== face.byteLength) throw new Error("font");
              return bytes;
            },
          },
          request.fontPrefix,
        );
        scope.postMessage({ id: request.id, type: "opened", document: engine.document });
      } else {
        if (!engine) throw new Error("closed");
        scope.postMessage({ id: request.id, type: "frame", frame: await engine.frame(request.view) });
      }
    } catch (error) {
      const code =
        error instanceof DocxPackageError
          ? error.code
          : error instanceof Error && error.message === "limit"
            ? "limit"
            : "parse";
      scope.postMessage({ id: request.id, type: "error", code });
    } finally {
      busy = false;
    }
  })();
};
