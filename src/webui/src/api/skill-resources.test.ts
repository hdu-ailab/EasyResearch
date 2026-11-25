import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteSkillResource, listSkillResources, patchSkillResource, readSkillResource } from "../api";
import { parseSkillResource } from "./parsers";

const row = {
  name: "stitch::react-components",
  source: "global",
  path: "/agent/skills/stitch-react-components",
  skillPath: "/agent/skills/stitch-react-components/SKILL.md",
};
afterEach(() => vi.unstubAllGlobals());

describe("Skill resource controls", () => {
  it("retains local description, enable state and deletion authority with conservative legacy defaults", () => {
    expect(parseSkillResource(row)).toMatchObject({ enabled: true, canDelete: false });
    expect(parseSkillResource({ ...row, description: "Draw figures", enabled: false, canDelete: true })).toMatchObject({
      description: "Draw figures",
      enabled: false,
      canDelete: true,
    });
    expect(() => parseSkillResource({ ...row, enabled: "false" })).toThrow();
    expect(() => parseSkillResource({ ...row, canDelete: "true" })).toThrow();
  });
  it("uses the existing exact-name route and only the strict enabled mutation", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ...row, enabled: false }));
    vi.stubGlobal("fetch", fetch);
    expect(await patchSkillResource(row.name, false)).toMatchObject({ name: row.name, enabled: false });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/skill-resources/stitch%3A%3Areact-components", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: '{"enabled":false}',
    });
  });
  it("checks deletion acknowledgement identity and propagates errors", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ deleted: true, name: row.name }))
      .mockResolvedValueOnce(Response.json({ deleted: true, name: "other" }))
      .mockResolvedValueOnce(Response.json({ error: "Directory changed" }, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    await expect(deleteSkillResource(row.name)).resolves.toEqual({ deleted: true, name: row.name });
    await expect(deleteSkillResource(row.name)).rejects.toThrow("Invalid API response");
    await expect(deleteSkillResource(row.name)).rejects.toThrow("Directory changed");
    expect(fetch.mock.calls[0]![0]).toBe("/api/skill-resources/stitch%3A%3Areact-components");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "DELETE" });
  });
  it("passes the resource owner's abort signal through the typed request budget", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json([row]));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    await listSkillResources(controller.signal);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/skill-resources", { signal: controller.signal });
  });
  it("passes the selected editor read's abort signal to its exact-name GET and refuses an already cancelled read", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ...row, content: "# Skill" }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    await expect(readSkillResource(row.name, controller.signal)).resolves.toMatchObject({
      name: row.name,
      content: "# Skill",
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/skill-resources/stitch%3A%3Areact-components", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(readSkillResource(row.name, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
