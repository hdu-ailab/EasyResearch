---
name: pdf-to-markdown
description: |-
  Convert research PDFs and other documents to Markdown using MarkItDown from the EasyResearch skill venv ($EASYRESEARCH_VENV). Use proactively when papers must be converted into readable text for agent analysis, especially inside ref_papers/pdf to ref_papers/text workflows.

  Examples:
  - user: "Convert these papers to Markdown" then run markitdown on each PDF and save .md files
  - user: "Make this PDF readable for the agent" then convert with MarkItDown and verify the output text
  - user: "Prepare ref_papers/text" then batch-convert public PDFs and record failures
license: MIT
metadata:
  hermes:
    tags: [pdf, markdown, markitdown, documents, research]
    category: documents
---

# PDF To Markdown

## Tool
Use the MarkItDown CLI from the EasyResearch skill venv (created by first-run
setup, never by npm install):

```bash
$EASYRESEARCH_VENV/bin/markitdown input.pdf -o output.md
```

On Windows the venv layout differs — use:

```powershell
$markitdown = Join-Path $env:EASYRESEARCH_VENV 'Scripts\markitdown.exe'
& $markitdown input.pdf -o output.md
```

If `$EASYRESEARCH_VENV` is unset or the binary is missing, fall back to
`markitdown` on PATH. Verify with:
```bash
echo $EASYRESEARCH_VENV
$EASYRESEARCH_VENV/bin/markitdown --help
```

PowerShell verification on Windows:

```powershell
$env:EASYRESEARCH_VENV
& (Join-Path $env:EASYRESEARCH_VENV 'Scripts\markitdown.exe') --help
```

## When To Use
Use MarkItDown when:
- A research paper PDF must be converted into Markdown for agent reading.
- The project workflow needs `ref_papers/pdf/` converted into `ref_papers/text/`.
- The PDF is public, user-provided, or otherwise legally accessible.
- The converted text will be used for `paper-material-package`, survey writing,
  component extraction, experiments, or citation verification.

Do not use it to bypass paywalls, login walls, captcha, DRM, or institutional access restrictions.

## Standard Research Workflow
For paper projects rooted at the exact session cwd:

```text
ref_papers/
  pdf/
  text/
  source.json
```

Convert one PDF:

```bash
$EASYRESEARCH_VENV/bin/markitdown ref_papers/pdf/paper.pdf -o ref_papers/text/paper.md
```

Batch conversion pattern:

```bash
for pdf in ref_papers/pdf/*.pdf; do
  name=$(basename "$pdf" .pdf)
  "$EASYRESEARCH_VENV/bin/markitdown" "$pdf" -o "ref_papers/text/$name.md"
done
```

Native Windows PowerShell batch conversion:

```powershell
$markitdown = Join-Path $env:EASYRESEARCH_VENV 'Scripts\markitdown.exe'
Get-ChildItem -LiteralPath 'ref_papers\pdf' -Filter '*.pdf' | ForEach-Object {
  $output = Join-Path 'ref_papers\text' ($_.BaseName + '.md')
  & $markitdown $_.FullName -o $output
}
```

Follow a different existing user layout only when the dispatch explicitly
supplies it.

After conversion:
- Read the first part of the Markdown output.
- Confirm title, abstract, section headings, tables, and references are at least partially readable.
- If conversion is poor, record the failure in `source.json` or a short conversion note.
- Keep the original PDF in `ref_papers/pdf/` and the converted Markdown in `ref_papers/text/`.

## Output Quality Rules
MarkItDown is the default converter, but conversion quality varies by PDF.

Accept the output when:
- Title and abstract are readable.
- Major section headings are preserved or recoverable.
- Method and experiment sections are readable enough for component extraction.
- Equations are at least partially recoverable or can be checked from the PDF when needed.

Mark the output as needing manual review when:
- Text order is badly scrambled.
- Equations are central but unreadable.
- Tables are destroyed and are needed for results.
- The PDF is scanned or image-only.
- References are missing or heavily corrupted.

## Fallbacks
If MarkItDown output is not usable:
- Try `pdftotext -layout` for a plain-text fallback.
- Try `pymupdf4llm` for an alternative Markdown conversion.
- Use arXiv HTML or abstract pages when available.
- For scanned PDFs, preserve the failed conversion and return `blocked` with the
  OCR cost/privacy decision as `required_user_input`; do not ask the user
  directly from Search.

Do not spend excessive time perfecting conversion for weakly relevant papers. Prioritize high-value selected papers.

## Source Manifest Notes
When a `source.json` manifest exists, update or create fields like:

```json
{
  "local_pdf": "ref_papers/pdf/paper.pdf",
  "local_text": "ref_papers/text/paper.md",
  "conversion_tool": "markitdown",
  "conversion_status": "ok / poor / failed",
  "conversion_notes": "method readable, tables poor"
}
```

## Verification Commands
Check the skill venv CLI (falls back to `markitdown` on PATH when
`$EASYRESEARCH_VENV` is unset):

```bash
"$EASYRESEARCH_VENV/bin/markitdown" --help
```

On native Windows use PowerShell:

```powershell
& (Join-Path $env:EASYRESEARCH_VENV 'Scripts\markitdown.exe') --help
```
