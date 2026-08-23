import { describe, expect, it, vi } from "vitest";
import {
  createTrayMenuTemplate,
  desktopWindowOptions,
  handleMainWindowClose,
  isCurrentDesktopDocument,
  renderLoadingDocument,
  TRAY_ICON_DATA_URL,
} from "./main-support";
import { beginDesktopExit, createDesktopLifecycleState } from "./lifecycle";

describe("desktop BrowserWindow options", () => {
  it("enforces the sandboxed preload boundary", () => {
    expect(desktopWindowOptions(
      "/app/preload.cjs",
      "persist:easyresearch-desktop",
    ).webPreferences).toEqual({
      preload: "/app/preload.cjs",
      partition: "persist:easyresearch-desktop",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    });
  });

  it("starts hidden until authenticated navigation finishes", () => {
    expect(desktopWindowOptions("/app/preload.cjs", "persist:test"))
      .toMatchObject({ show: false, width: 1280, height: 820 });
  });

  it("accepts only the exact rendered Web UI document", () => {
    const origin = "http://127.0.0.1:43123";
    expect(isCurrentDesktopDocument(`${origin}/`, origin, true, true)).toBe(true);
    expect(isCurrentDesktopDocument(`${origin}/`, origin, false, true)).toBe(false);
    expect(isCurrentDesktopDocument(`${origin}/`, origin, true, false)).toBe(false);
    expect(isCurrentDesktopDocument(`${origin}/unauthorized`, origin, true, true)).toBe(false);
    expect(isCurrentDesktopDocument("http://127.0.0.1:43124/", origin, true, true)).toBe(false);
  });
});

describe("desktop loading document", () => {
  it("escapes setup status and applies a restrictive content policy", () => {
    const html = renderLoadingDocument('<script>alert("x")</script>');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain('<script>alert("x")</script>');
  });
});

describe("desktop window and tray actions", () => {
  it("uses a supported in-memory PNG for the tray icon", () => {
    expect(TRAY_ICON_DATA_URL).toMatch(/^data:image\/png;base64,/);
    const bytes = Buffer.from(TRAY_ICON_DATA_URL.split(",")[1]!, "base64");
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it("hides close before terminal exit and allows close afterward", () => {
    const event = { preventDefault: vi.fn() };
    const hide = vi.fn();
    handleMainWindowClose(createDesktopLifecycleState(), event, hide);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(hide).toHaveBeenCalledOnce();

    event.preventDefault.mockClear();
    hide.mockClear();
    handleMainWindowClose(beginDesktopExit(createDesktopLifecycleState()), event, hide);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
  });

  it("wires Open, Check for Updates, and Exit to distinct callbacks", () => {
    const open = vi.fn();
    const check = vi.fn();
    const exit = vi.fn();
    const template = createTrayMenuTemplate({ open, check, exit });

    expect(template.map((item) => item.label)).toEqual([
      "Open EasyResearch",
      "Check for Updates",
      undefined,
      "Exit",
    ]);
    template[0]!.click?.();
    template[1]!.click?.();
    template[3]!.click?.();
    expect(open).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });
});
