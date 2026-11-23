/** Incremental terminal-control removal. Sequence state has constant space even
 * for an unterminated OSC/DCS; no output is interpreted as HTML or a terminal. */
export class ShellOutputText {
  private state: "text" | "escape" | "csi" | "string" | "string-escape" | "intermediate" = "text";
  private carriage = false;

  append(chunk: string): string {
    let output = "";
    for (const char of chunk) {
      const code = char.charCodeAt(0);
      if (this.state === "string") {
        if (char === "\x07" || char === "\x9c") this.state = "text";
        else if (char === "\x1b") this.state = "string-escape";
        continue;
      }
      if (this.state === "string-escape") {
        this.state = char === "\\" ? "text" : char === "\x1b" ? "string-escape" : "string";
        continue;
      }
      if (char === "\x1b") {
        this.state = "escape";
        continue;
      }
      if (this.state === "escape") {
        this.state =
          char === "["
            ? "csi"
            : "]PX^_".includes(char)
              ? "string"
              : code >= 0x20 && code <= 0x2f
                ? "intermediate"
                : "text";
        continue;
      }
      if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "text";
        continue;
      }
      if (this.state === "intermediate") {
        if (code >= 0x30 && code <= 0x7e) this.state = "text";
        continue;
      }
      if (char === "\x9b") {
        this.state = "csi";
        continue;
      }
      if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
        this.state = "string";
        continue;
      }
      if (char === "\r") {
        output += "\n";
        this.carriage = true;
        continue;
      }
      if (char === "\n" && this.carriage) {
        this.carriage = false;
        continue;
      }
      if ((code < 0x20 && char !== "\n" && char !== "\t") || (code >= 0x7f && code <= 0x9f)) continue;
      this.carriage = false;
      output += char;
    }
    return output;
  }
}

export const SHELL_OUTPUT_BYTES = 64 * 1024;
export function shellOutputTail(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= SHELL_OUTPUT_BYTES) return text;
  let start = bytes.length - SHELL_OUTPUT_BYTES;
  while (((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
}
