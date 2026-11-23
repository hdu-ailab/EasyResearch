import { describe, expect, it } from "vitest";
import { fetchNpmUpdateVersion } from "./npm-update-registry";

describe("bounded official npm update metadata", () => {
  it("accepts only stable exact versions from the fixed official endpoint", async () => {
    const requests: string[] = [];
    const result = await fetchNpmUpdateVersion(AbortSignal.timeout(1000), { fetch: async (url) => { requests.push(String(url)); return Response.json({ name: "easyresearch", version: "2.3.4" }); } });
    expect(result).toBe("2.3.4");
    expect(requests).toEqual(["https://registry.npmjs.org/easyresearch/latest"]);
    for (const version of ["latest", "2.3.4-beta.1", "2.3.4;echo bad"]) {
      await expect(fetchNpmUpdateVersion(AbortSignal.timeout(1000), { fetch: async () => Response.json({ name: "easyresearch", version }) })).rejects.toThrow();
    }
  });
  it("bounds bodies and owns cancellation while reading a stalled body", async () => {
    await expect(fetchNpmUpdateVersion(AbortSignal.timeout(1000), { fetch: async () => new Response(" ".repeat(262145)) })).rejects.toThrow();
    let cancelled = false;
    const abort = new AbortController();
    const pending = fetchNpmUpdateVersion(abort.signal, { fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
    await Promise.resolve(); abort.abort();
    await expect(pending).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
});
