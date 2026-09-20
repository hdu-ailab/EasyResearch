import { afterEach, describe, expect, it } from "vitest";
import { applyUiVersion, CLASSIC_FAVICON, CURRENT_FAVICON } from "./ui-version";

function iconLink(): HTMLLinkElement {
  const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (existing) return existing;
  const link = document.createElement("link");
  link.rel = "icon";
  document.head.append(link);
  return link;
}

afterEach(() => {
  document.querySelector('link[rel="icon"]')?.remove();
});

describe("applyUiVersion", () => {
  it("keeps the shipped dolphin icon for the current version", () => {
    const link = iconLink();
    link.href = "https://example.test/whatever.svg";

    applyUiVersion("current");

    expect(new URL(link.href).pathname).toBe("/favicon.svg");
    expect(CURRENT_FAVICON).toBe("/favicon.svg");
  });

  it("restores the pre-refresh inline icon for the classic version", () => {
    const link = iconLink();

    applyUiVersion("classic");

    expect(link.getAttribute("href")).toBe(CLASSIC_FAVICON);
    expect(CLASSIC_FAVICON.startsWith("data:image/svg+xml,")).toBe(true);
  });

  it("switches back and forth without touching other head content", () => {
    const link = iconLink();
    const title = document.createElement("title");
    title.textContent = "EasyResearch";
    document.head.append(title);

    applyUiVersion("classic");
    const classic = link.getAttribute("href");
    applyUiVersion("current");

    expect(classic).toBe(CLASSIC_FAVICON);
    expect(new URL(link.href).pathname).toBe("/favicon.svg");
    expect(document.title).toBe("EasyResearch");
    title.remove();
  });

  it("is a no-op when the document carries no icon link", () => {
    expect(document.querySelector('link[rel="icon"]')).toBeNull();
    expect(() => applyUiVersion("classic")).not.toThrow();
  });
});
