/** Presentation only: command-like code never becomes a clickable file path. */
export function inlineCodeKind(text: string): "command" | "skill" | undefined {
  if (/^\/skill:[\w.-]+(?:\s|$)/u.test(text)) return "skill";
  // Recognize bare invocations and known command arguments without classifying
  // every spaced absolute path (e.g. /Research Papers/paper.md) as a command.
  if (/^\/[\w-]+$/u.test(text) || /^\/(?:compact|history|statistics|name|skill:[\w.-]+)\s/u.test(text))
    return "command";
  if (/^[>$]\s/u.test(text) || /(?:\s--?[\w-]|\s(?:&&|\|\||[;&|])\s)/u.test(text)) return "command";
  if (/^[A-Za-z_]\w*=/u.test(text)) return "command";
  const match = /^(\S+)\s+\S/u.exec(text);
  if (!match) return;
  const executable = match[1]?.split(/[\\/]/u).at(-1) ?? "";
  if (
    /^(?:python(?:\d(?:\.\d+)?)?|pip\d?|node|npm|npx|bun|bunx|pnpm|yarn|uv|conda|git|gh|ssh|scp|rsync|curl|wget|bash|sh|zsh|fish|pwsh|powershell|cmd|sudo|env|source|cd|ls|cat|head|tail|grep|rg|find|echo|printf|mkdir|cp|mv|rm|chmod|make|cmake|docker|podman|pytest|ruff|pdflatex|xelatex|lualatex|latexmk|bibtex|biber|tectonic|pandoc|tar|unzip|zip|easyresearch|opencode)(?:\.exe)?$/iu.test(
      executable,
    ) ||
    /\.(?:sh|bash|py|ps1|exe|bat|cmd)$/iu.test(executable) ||
    // An unqualified executable followed by a path is ambiguous with a spaced
    // filename. Prefer inert command code; explicit Markdown links remain exact.
    /^[\w.-]+\s+\S*[\\/]\S/u.test(text)
  )
    return "command";
}
