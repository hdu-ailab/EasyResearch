import { describe, expect, it, vi } from "vitest";
import { FileReferenceBatch } from "./file-reference-batch";

describe("view-owned file reference batching", () => {
  it("removes only abandoned queued work and settles both duplicate consumers", async () => {
    const read = vi.fn(async (paths: string[]) => ({
      references: paths.map((reference) => ({ reference, paths: [`/p/${reference}`], truncated: false })),
    }));
    const batch = new FileReferenceBatch(read);
    const gone = batch.acquire("absent");
    const first = batch.acquire("README");
    const duplicate = batch.acquire("README");
    const rejected = expect(gone.promise).rejects.toMatchObject({ name: "AbortError" });
    gone.release();
    await rejected;
    expect(await first.promise).toEqual(await duplicate.promise);
    expect(read.mock.calls.map(([paths]) => paths)).toEqual([["README"]]);
    batch.dispose();
  });
  it("does not let an abandoned late response settle a new lease for the same path", async () => {
    const completions: Array<
      (result: { references: Array<{ reference: string; paths: string[]; truncated: boolean }> }) => void
    > = [];
    const read = vi.fn(
      (_paths: string[], _signal: AbortSignal) =>
        new Promise<Parameters<(typeof completions)[number]>[0]>((resolve) => completions.push(resolve)),
    );
    const batch = new FileReferenceBatch(read);
    const old = batch.acquire("README");
    const rejected = expect(old.promise).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    old.release();
    await rejected;
    const fresh = batch.acquire("README");
    const settled = vi.fn();
    void fresh.promise.then(settled);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(read).toHaveBeenCalledTimes(2);
    completions[0]!({ references: [{ reference: "README", paths: ["/old/README"], truncated: false }] });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    completions[1]!({ references: [{ reference: "README", paths: ["/fresh/README"], truncated: false }] });
    expect((await fresh.promise).paths).toEqual(["/fresh/README"]);
    batch.dispose();
  });
  it("drops a queued candidate when its last consumer releases", async () => {
    const read = vi.fn();
    const batch = new FileReferenceBatch(read);
    const lease = batch.acquire("README");
    const rejected = expect(lease.promise).rejects.toMatchObject({ name: "AbortError" });
    lease.release();
    await rejected;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(read).not.toHaveBeenCalled();
    batch.dispose();
  });
  it("keeps duplicate and mixed consumers alive, aborting only after the final interested consumer releases", async () => {
    const read = vi.fn((_paths: string[], _signal: AbortSignal) => new Promise<never>(() => {}));
    const batch = new FileReferenceBatch(read);
    const first = batch.acquire("README");
    const duplicate = batch.acquire("README");
    const other = batch.acquire("LICENSE");
    const rejected = [first, duplicate, other].map((lease) =>
      expect(lease.promise).rejects.toMatchObject({ name: "AbortError" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const signal = read.mock.calls[0]![1];
    first.release();
    expect(signal.aborted).toBe(false);
    duplicate.release();
    expect(signal.aborted).toBe(false);
    other.release();
    expect(signal.aborted).toBe(true);
    await Promise.all(rejected);
    batch.dispose();
  });
  it("settles the remaining mixed-batch consumer and cannot cache an abandoned candidate", async () => {
    let complete!: (value: { references: Array<{ reference: string; paths: string[]; truncated: boolean }> }) => void;
    const read = vi.fn(
      () =>
        new Promise<Parameters<typeof complete>[0]>((resolve) => {
          complete = resolve;
        }),
    );
    const batch = new FileReferenceBatch(read);
    const first = batch.acquire("README");
    const other = batch.acquire("LICENSE");
    const rejected = expect(first.promise).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    first.release();
    await rejected;
    complete({
      references: ["README", "LICENSE"].map((reference) => ({
        reference,
        paths: [`/p/${reference}`],
        truncated: false,
      })),
    });
    expect((await other.promise).paths).toEqual(["/p/LICENSE"]);
    const retry = batch.acquire("README");
    const aborted = expect(retry.promise).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(read).toHaveBeenCalledTimes(2);
    batch.dispose();
    await aborted;
  });
  it("retries failures only after another request, without caching a permanent rejection", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ references: [{ reference: "README", paths: ["/p/README"], truncated: false }] });
    const batch = new FileReferenceBatch(read);
    await expect(batch.resolve("README")).rejects.toThrow("offline");
    expect(read).toHaveBeenCalledTimes(1);
    expect((await batch.resolve("README")).paths).toEqual(["/p/README"]);
    expect(read).toHaveBeenCalledTimes(2);
    batch.dispose();
  });
  it("deduplicates concurrent consumers and sends at most 64 references per request", async () => {
    const read = vi.fn(async (paths: string[]) => ({
      references: paths.map((reference) => ({ reference, paths: [`/p/${reference}`], truncated: false })),
    }));
    const batch = new FileReferenceBatch(read);
    const first = batch.resolve("README");
    const duplicate = batch.resolve("README");
    const results = await Promise.all([
      first,
      duplicate,
      ...Array.from({ length: 80 }, (_, i) => batch.resolve(`file${i}`)),
    ]);
    expect(results[1]).toEqual(results[0]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.every(([paths]) => paths.length <= 64)).toBe(true);
    expect(results[0]?.paths).toEqual(["/p/README"]);
    batch.dispose();
  });
  it("aborts stale view requests and never probes shares", async () => {
    const read = vi.fn((_paths: string[], _signal: AbortSignal) => new Promise<never>(() => {}));
    const batch = new FileReferenceBatch(read);
    expect((await batch.resolve("\\\\host\\share\\file")).paths).toEqual([]);
    const promise = batch.resolve("README");
    const rejected = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    batch.dispose();
    await rejected;
    expect(read.mock.calls[0]?.[1].aborted).toBe(true);
  });
});
