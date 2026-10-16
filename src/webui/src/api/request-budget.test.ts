import { expect, it } from "vitest";
import { RequestBudget } from "./request-budget";

it("retains slots through complete operations and reserves Stop admission", async () => {
  const queue = new RequestBudget();
  const started: string[] = [];
  const releases: (() => void)[] = [];
  const work = (name: string) =>
    queue.run(name, undefined, async () => {
      started.push(name);
      await new Promise<void>((r) => releases.push(r));
    });
  const tasks = [
    work("/api/entries?path=a"),
    work("/api/file?path=b"),
    work("/api/file?path=c"),
    work("/api/models"),
    work("/api/agents"),
  ];
  await Promise.resolve();
  await Promise.resolve();
  expect(started).toEqual(["/api/entries?path=a", "/api/file?path=b", "/api/models"]);
  const stop = work("/api/sessions/s/abort");
  await Promise.resolve();
  expect(started.at(-1)).toBe("/api/sessions/s/abort");
  for (let i = 0; i < 10; i++) {
    releases.splice(0).forEach((r) => {
      r();
    });
    await Promise.resolve();
    await Promise.resolve();
  }
  await Promise.all([...tasks, stop]);
  expect(started).toContain("/api/file?path=c");
  expect(started).toContain("/api/agents");
});

it("cancels queued requests before their operation can mutate state", async () => {
  const queue = new RequestBudget();
  const releases: (() => void)[] = [];
  const running = Array.from({ length: 3 }, () =>
    queue.run("/api/models", undefined, () => new Promise<void>((r) => releases.push(r))),
  );
  await Promise.resolve();
  const controller = new AbortController();
  let executed = false;
  const queued = queue.run("/api/agents", controller.signal, async () => {
    executed = true;
  });
  const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await rejected;
  releases.forEach((r) => {
    r();
  });
  await Promise.all(running);
  expect(executed).toBe(false);
  await expect(
    queue.run("/api/models", undefined, async () => {
      throw new Error("failed");
    }),
  ).rejects.toThrow("failed");
  await expect(queue.run("/api/models", undefined, async () => "recovered")).resolves.toBe("recovered");
});
