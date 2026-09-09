import { mkdirSync, mkdtempSync, watch as nativeWatch, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileEntryDto } from "../../../web/contracts";
import { DirectoryService } from "../../../web/directories";
import { createFileWatcherFactory, type FileWatcherEvent, type WatchImplementation } from "../../../web/file-watcher";
import * as api from "../api";
import { FileBrowser } from "./FileBrowser";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listEntries: vi.fn(),
  replaceFileWatchDirectories: vi.fn(),
  readFileContent: vi.fn(),
}));

afterEach(() => vi.useRealTimers());

async function nativeBarrier(promise: Promise<void>) {
  const cancellation = new AbortController();
  try {
    await Promise.race([
      promise,
      delay(2_000, undefined, { signal: cancellation.signal }).then(() => {
        throw new Error("Native directory watcher did not settle");
      }),
    ]);
  } finally {
    cancellation.abort();
  }
}

describe("FilesPanel directory recovery", () => {
  it.each([
    { recovery: "parent event", responses: "immediate" },
    { recovery: "newer matching revision", responses: "immediate" },
    { recovery: "parent event", responses: "parent-first" },
    { recovery: "parent event", responses: "child-first" },
    { recovery: "parent event", responses: "batched" },
  ])(
    "refreshes expanded nested listings after $recovery recovery with $responses responses",
    async ({ recovery, responses }) => {
      const root = mkdtempSync(join(tmpdir(), "easyresearch-files-panel-watch-"));
      const results = join(root, "results");
      const nested = join(results, "nested");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "old.txt"), "old directory");
      const directories = new DirectoryService(root);
      let holdListings = false;
      const heldListings = new Map<string, { entries: FileEntryDto[]; resolve: (entries: FileEntryDto[]) => void }>();
      vi.mocked(api.listEntries).mockImplementation(async (path) => {
        const entries = directories.listEntries(path).entries;
        if (!holdListings) return entries;
        return new Promise<FileEntryDto[]>((resolve) => heldListings.set(path, { entries, resolve }));
      });

      const active = new Set<ReturnType<typeof nativeWatch>>();
      const retired = Promise.withResolvers<void>();
      const recovered = Promise.withResolvers<void>();
      let restoring = false;
      const watch: WatchImplementation = (path, options, listener) => {
        const handle = nativeWatch(path, options, listener);
        active.add(handle);
        if (restoring && active.size === 3) recovered.resolve();
        return {
          on(event, callback) {
            handle.on(event, callback);
            return this;
          },
          close() {
            active.delete(handle);
            handle.close();
            if (active.size === 1) retired.resolve();
          },
        };
      };
      const changes: FileWatcherEvent[] = [];
      const manager = createFileWatcherFactory({ debug() {}, info() {}, warn() {}, error() {} }, watch).create({
        cwd: root,
        onEvent: (event) => changes.push(event),
      });
      const lease = manager.acquireLease();
      manager.replaceLease(lease, 1, [root, results, nested]);
      const consumed = vi.fn();
      const view = render(<FileBrowser root={root} onFileEventsConsumed={consumed} />);
      try {
        const user = userEvent.setup();
        await user.click(await screen.findByText("results"));
        await user.click(await screen.findByText("nested"));
        expect(await screen.findByText("old.txt")).toBeVisible();

        // Hold only the coalescing clock. Real native callbacks must retire the old
        // handles before recreation, with no directory event delivered to the UI yet.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        renameSync(results, `${results}.old`);
        await nativeBarrier(retired.promise);
        expect(active.size).toBe(1);
        expect(changes).toEqual([]);
        restoring = true;
        mkdirSync(nested, { recursive: true });
        writeFileSync(join(nested, "new.txt"), "created before the replacement is watched");
        if (recovery === "newer matching revision") {
          expect(manager.replaceLease(lease, 2, [root, results, nested])).toBe(true);
        }
        await nativeBarrier(recovered.promise);
        expect(changes).toEqual([]);
        await vi.advanceTimersByTimeAsync(200);
        vi.useRealTimers();

        holdListings = responses !== "immediate";
        const queued = changes.map((event, index) => ({ sequence: index + 1, event }));
        if (responses === "batched") {
          await act(async () => {
            for (let index = 0; index < queued.length; index += 1) {
              view.rerender(
                <FileBrowser root={root} fileEvents={queued.slice(0, index + 1)} onFileEventsConsumed={consumed} />,
              );
            }
          });
        } else {
          // Commit each real frame, but do not let a listing resolve between frames.
          for (const entry of queued) {
            await act(async () => {
              view.rerender(<FileBrowser root={root} fileEvents={[entry]} onFileEventsConsumed={consumed} />);
            });
          }
        }
        expect(consumed.mock.calls.map(([sequence]) => sequence)).toEqual(
          responses === "batched" ? [queued.at(-1)!.sequence] : queued.map((entry) => entry.sequence),
        );
        if (holdListings) {
          expect([...heldListings.keys()].sort()).toEqual([root, results, nested].sort());
          holdListings = false;
          const order = responses === "child-first" ? [nested, results, root] : [root, results, nested];
          for (const path of order) {
            await act(async () => {
              const listing = heldListings.get(path)!;
              listing.resolve(listing.entries);
            });
          }
        }
        await waitFor(() => expect(screen.queryByText("new.txt")).toBeVisible());
        expect(screen.queryByText("old.txt")).not.toBeInTheDocument();
        expect(changes.map((event) => event.properties.file)).toEqual(expect.arrayContaining([results, nested]));
        expect(screen.getByTitle(nested)).toHaveAttribute("aria-expanded", "true");
      } finally {
        await manager.close();
        view.unmount();
        vi.useRealTimers();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
