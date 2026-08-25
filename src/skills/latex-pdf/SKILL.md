---
name: latex-pdf
description: |-
  Build LaTeX manuscripts into PDFs, diagnose TeX toolchain errors, choose pdflatex/xelatex/lualatex/latexmk commands, clean build artifacts, and summarize compilation warnings. Use proactively when a user asks to compile, rebuild, export, or troubleshoot a .tex paper, IEEE/ACM/Elsevier template, bibliography, missing package, figure, or citation issue. When no local TeX toolchain is installed, compile through Overleaf in a browser instead.

  Examples:
  - user: "Compile this LaTeX paper" → run latexmk or a safe fallback and report the PDF path
  - user: "Convert the JSEN tex to PDF" → build with latexmk -pdf, inspect warnings, and verify output
  - user: "pdflatex says a package is missing" → identify the missing package, remove unused packages or recommend TeX Live package install
  - user: "References are undefined" → rerun the correct bibtex/biber/pdflatex sequence or latexmk
  - user: "Clean LaTeX auxiliary files" → run latexmk cleanup without deleting source files or figures
---
# LaTeX PDF Build Workflow

## When To Use

- Use for `.tex` to `.pdf` builds, manuscript template compilation, citation/reference warnings, missing graphics, missing `.sty` files, and LaTeX cleanup.
- Prefer `latexmk` when available because it handles repeated runs, BibTeX/Biber, and cross-references automatically.
- Use `pdflatex` for IEEE/JSEN and most standard journal templates unless the document requires Unicode/CJK text or system fonts.
- Use `xelatex` or `lualatex` when the source uses `fontspec`, CJK body text, or system font selection.
- When no local TeX toolchain is detected, use the Overleaf compilation flow
  below instead of failing or guessing.

## Discovery

- Locate the main file with `Glob` for `*.tex` if the user does not specify it.
- Read the first 80 lines of likely main files and prefer the file containing `\documentclass` and `\begin{document}`.
- Check graphics paths from `\includegraphics{...}` when image errors occur.
- Check whether the project uses inline `thebibliography`, BibTeX (`\bibliography{...}`), or BibLaTeX (`\addbibresource{...}`).

## Paper Pipeline Paths

- In the bundled paper workflow, treat the exact session cwd as the project
  root, keep derived LaTeX under `manuscript/latex/`, and deliver the compiled
  PDF at `manuscript/manuscript.pdf`.
- Keep `manuscript/manuscript.md` authoritative; compilation must not replace
  it with generated LaTeX.
- Follow another existing layout only when the task explicitly supplies it.
- When the TeX engine writes the PDF inside `manuscript/latex/`, copy the
  successful final PDF to `manuscript/manuscript.pdf` and verify that path.

## Environment Detection

Before building, detect a local TeX toolchain. Prefer local compilation when
available; fall back to the Overleaf flow below when it is not.

Unix (Linux/macOS):

```bash
which latexmk pdflatex xelatex
```

Windows PowerShell:

```powershell
Get-Command latexmk,pdflatex,xelatex -ErrorAction SilentlyContinue
```

If the commands are not on PATH, probe the common Windows install locations:

```powershell
Test-Path "$env:LOCALAPPDATA\Programs\MiKTeX\miktex\bin\x64\latexmk.exe"
Get-ChildItem C:\texlive -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
```

When only a probed path is found (e.g. MiKTeX or TeX Live bin directory), call
the engines by their absolute path instead of modifying the system PATH. For
example:

```powershell
& "$env:LOCALAPPDATA\Programs\MiKTeX\miktex\bin\x64\latexmk.exe" -pdf -interaction=nonstopmode -halt-on-error main.tex
```

A toolchain counts as available when `latexmk` or `pdflatex` resolves. When
neither resolves anywhere, proceed to `## Overleaf Compilation` below.

## Build Commands

Run commands from the directory containing the main `.tex` file. Use the Bash tool `workdir` parameter rather than `cd`.

Preferred command:

```bash
latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex
```

If `latexmk` is unavailable and there is no external `.bib` file:

```bash
pdflatex -interaction=nonstopmode -halt-on-error main.tex
pdflatex -interaction=nonstopmode -halt-on-error main.tex
```

If BibTeX is used and `latexmk` is unavailable:

```bash
pdflatex -interaction=nonstopmode -halt-on-error main.tex
bibtex main
pdflatex -interaction=nonstopmode -halt-on-error main.tex
pdflatex -interaction=nonstopmode -halt-on-error main.tex
```

If BibLaTeX/Biber is used and `latexmk` is unavailable:

```bash
pdflatex -interaction=nonstopmode -halt-on-error main.tex
biber main
pdflatex -interaction=nonstopmode -halt-on-error main.tex
pdflatex -interaction=nonstopmode -halt-on-error main.tex
```

For CJK/fontspec documents:

```bash
latexmk -xelatex -interaction=nonstopmode -halt-on-error main.tex
```

## Overleaf Compilation

Use Overleaf only when `## Environment Detection` finds no local TeX
toolchain. Overleaf requires a logged-in account; the login state is reused
through a dedicated Chrome profile, never through stored passwords.

### First-time login (one time only)

1. Ensure `playwright-cli` is available; prefer Chrome Stable.
2. Open Overleaf with the dedicated profile:
   ```bash
   playwright-cli open --browser=chrome --profile=~/.cache/playwright-cli/overleaf-profile https://www.overleaf.com/login
   ```
3. Return `blocked` with `required_user_input` asking the caller to have the user
   complete login in the opened browser and close it. Preserve the LaTeX source;
   the Research Assistant can continue this Writing child after login. The
   cookies are saved in the profile for reuse.
4. Do not request or store the user's Overleaf password.

### Compile flow (every time)

1. Open Overleaf with the same profile:
   ```bash
   playwright-cli open --browser=chrome --profile=~/.cache/playwright-cli/overleaf-profile https://www.overleaf.com/project
   ```
2. If the page asks for login, the stored login state has expired — preserve the
   source and return the first-time-login blocked handoff. Do not wait for a
   direct user response inside the Writing child.
3. Create a new blank project (New Project → Blank Project).
4. Upload every source file from `manuscript/latex/`: the main `*.tex`,
   `*.bib`, all figures referenced by `\includegraphics{...}`, and any
   `.cls`/`.sty` files. Preserve the project-internal layout.
5. Click Recompile and wait for the build to finish.
6. From the file tree, open the compiled PDF (named after the main `.tex`),
   download it, and save it to `manuscript/manuscript.pdf`. Verify the file
   exists and is a valid PDF.
7. On compile failure, read the error list in the Overleaf log panel, report
   the first fatal error and its log line, and follow the same missing-package
   reasoning as `## Error Handling` (confirm usage before removing
   `\usepackage{...}`, then fix or report).
8. Treat Overleaf strictly as a build executor: do not make large
   experimental edits to the manuscript in the Overleaf editor.

## Installation Guides

When the user prefers a local toolchain over Overleaf, install one of these.
After installing, reopen the terminal so PATH refreshes, then re-run
`## Environment Detection`.

| Platform | Install method | Command / guide |
|---|---|---|
| Debian/Ubuntu | apt | `sudo apt install texlive-latex-recommended texlive-latex-extra texlive-xetex texlive-bibtex-extra` |
| Arch Linux | pacman | `sudo pacman -S texlive-most texlive-lang` |
| macOS | Homebrew | `brew install --cask mactex` (full) or `brew install --cask basictex` (minimal) |
| Windows | MiKTeX | Download the MiKTeX installer from https://miktex.org/download, install, then open a new terminal so PATH updates |

For missing individual packages on an existing TeX Live install, keep the
existing guidance in `## Error Handling`: check whether the package is used,
remove unused `\usepackage{...}` lines, and only then recommend the TeX Live
package for the user's distribution.

## Cleanup

- Use `latexmk -c` to remove auxiliary files while preserving the PDF.
- Use `latexmk -C` only when the user explicitly wants to remove generated PDFs too.
- Never delete source `.tex`, `.bib`, `.cls`, `.sty`, figures, or template files during cleanup.

## Error Handling

- If the build fails, report the first fatal error and the relevant log line.
- For missing packages, first check whether the package is actually used. Remove unused `\usepackage{...}` lines when safe and task-appropriate.
- If the package is required, recommend the relevant TeX Live package. On Arch Linux, search with `pacman -Ss <name>` or `pacman -F <file>` after the file database is available.
- For missing figures, verify file paths, extensions, case sensitivity, and whether the selected engine supports the format.
- For undefined citations/references, rerun with `latexmk`; if still unresolved, check key spelling and bibliography inclusion.

## Reporting

- State whether PDF generation succeeded.
- Give the absolute or project-relative PDF path.
- Summarize only meaningful warnings: undefined references/citations, missing fonts/packages/figures, severe overfull boxes, or template-specific issues.
- Mention routine underfull/overfull boxes as non-fatal unless they affect visible layout.
