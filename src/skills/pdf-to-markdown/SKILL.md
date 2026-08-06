---
name: pdf-to-markdown
description: |-
  Convert research PDFs and other documents to Markdown using a locally installed Microsoft MarkItDown CLI ({{MARKITDOWN_BIN}}). Use proactively when papers must be converted into readable text for agent analysis, especially inside ref_papers/pdf to ref_papers/text workflows.

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

## Placeholders

| Token | Meaning | Generic example |
|-------|---------|-----------------|
| `{{MARKITDOWN_BIN}}` | Absolute path of the local MarkItDown CLI | `~/tools/markitdown/.venv/bin/markitdown` |

## Tool
Use the local Microsoft MarkItDown installation:

```bash
markitdown input.pdf -o output.md
```

The alias is configured for bash and fish. If aliases are unavailable in a non-interactive shell, use the absolute CLI path:

```bash
{{MARKITDOWN_BIN}} input.pdf -o output.md
```

## When To Use
Use MarkItDown when:
- A research paper PDF must be converted into Markdown for agent reading.
- The project workflow needs `ref_papers/pdf/` converted into `ref_papers/text/`.
- The PDF is public, user-provided, or otherwise legally accessible.
- The converted text will be used for literature review, component extraction, or citation notes.

Do not use it to bypass paywalls, login walls, captcha, DRM, or institutional access restrictions.

## Standard Research Workflow
For project workspaces with this layout:

```text
workspace/
  ref_papers/
    pdf/
    text/
    source.json
```

Convert one PDF:

```bash
markitdown workspace/ref_papers/pdf/paper.pdf -o workspace/ref_papers/text/paper.md
```

Batch conversion pattern:

```bash
for pdf in workspace/ref_papers/pdf/*.pdf; do
  name=$(basename "$pdf" .pdf)
  markitdown "$pdf" -o "workspace/ref_papers/text/$name.md"
done
```

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
- For scanned PDFs, ask before using OCR-heavy workflows.

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
Check the CLI:

```bash
markitdown --help
```

Check the installed absolute path:

```bash
{{MARKITDOWN_BIN}} --help
```
