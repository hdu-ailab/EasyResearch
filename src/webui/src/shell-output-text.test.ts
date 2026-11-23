import { describe, expect, it } from "vitest";
import { SHELL_OUTPUT_BYTES, ShellOutputText, shellOutputTail } from "./shell-output-text";

describe("bounded shell text", () => {
  it("removes split CSI/OSC/DCS controls without losing Unicode or duplicating CRLF", () => {
    const text = new ShellOutputText();
    const chunks = [
      "\x1b[3",
      "1m阶段一\r",
      "\n\x1b]8;;https://example.test",
      "\x1b",
      "\\结果\x1b]8;;\x07\x1bPprivate",
      "\x1b\\\x1b[0m\r完成 😀",
    ];
    expect(chunks.map((chunk) => text.append(chunk)).join("")).toBe("阶段一\n结果\n完成 😀");
  });
  it("bounds output on complete UTF-8 characters and does not retain unterminated control payload", () => {
    const tail = shellOutputTail(`prefix${"汉😀".repeat(20000)}`);
    expect(new TextEncoder().encode(tail).byteLength).toBeLessThanOrEqual(SHELL_OUTPUT_BYTES);
    expect(tail).not.toContain("�");
    const text = new ShellOutputText();
    expect(text.append(`\x1b]${"secret".repeat(20000)}`)).toBe("");
    expect(text.append("\x07visible")).toBe("visible");
  });
});
