import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderIcon } from "./ProviderIcon";

describe("ProviderIcon", () => {
  it("renders the sprite symbol for a known provider id", () => {
    const { container } = render(<ProviderIcon id="anthropic" />);
    const use = container.querySelector('[data-component="provider-icon"] use');
    expect(use?.getAttribute("href")).toMatch(/#anthropic$/);
  });

  it("remaps Pi provider ids that differ from the sprite sheet", () => {
    const { container } = render(<ProviderIcon id="together" />);
    const use = container.querySelector('[data-component="provider-icon"] use');
    expect(use?.getAttribute("href")).toMatch(/#togetherai$/);
  });

  it("falls back to the synthetic glyph for unknown provider ids", () => {
    const { container } = render(<ProviderIcon id="custom-local-llm" />);
    const use = container.querySelector('[data-component="provider-icon"] use');
    expect(use?.getAttribute("href")).toMatch(/#synthetic$/);
  });

  it("applies className and aria-hidden", () => {
    const { container } = render(<ProviderIcon id="openai" className="size-4" />);
    const svg = container.querySelector('[data-component="provider-icon"]');
    expect(svg).toHaveClass("size-4");
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });
});
