---
name: latex-pdf
description: |-
  Build LaTeX manuscripts into PDFs, diagnose TeX toolchain errors, choose pdflatex/xelatex/lualatex/latexmk commands, clean build artifacts, and summarize compilation warnings. Use proactively when a user asks to compile, rebuild, export, or troubleshoot a .tex paper, IEEE/ACM/Elsevier template, bibliography, missing package, figure, or citation issue.

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
