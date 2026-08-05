// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TrustDialog } from "./TrustDialog";

const options = [
  { label: "Always trust this project", trusted: true, savesDecision: true },
  { label: "Trust for this session only", trusted: true, savesDecision: false },
];

describe("TrustDialog", () => {
  it("renders native option labels", () => {
    render(<TrustDialog options={options} onApply={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("Always trust this project")).toBeTruthy();
    expect(screen.getByText("Trust for this session only")).toBeTruthy();
  });

  it("emits the exact native option index on apply", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<TrustDialog options={options} onApply={onApply} onCancel={() => {}} />);
    await user.click(screen.getByText("Trust for this session only"));
    expect(onApply).toHaveBeenCalledWith(1);
  });

  it("cancels without making a trust call", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onApply = vi.fn();
    render(<TrustDialog options={options} onApply={onApply} onCancel={onCancel} />);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });
});
