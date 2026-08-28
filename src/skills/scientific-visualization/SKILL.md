---
name: scientific-visualization
description: Use when Figures must create or audit a data-driven scientific chart, uncertainty or missing-data display, multi-panel plot, accessible palette, provenance manifest, or publication export rather than a Draw.io diagram.
license: MIT
compatibility: Python 3.12 project-local environment; optional Plotly static export requires an existing compatible Chrome/Chromium.
metadata:
  version: "1.1"
  adaptation: "easyresearch.1"
  upstream: https://github.com/K-Dense-AI/scientific-agent-skills/tree/36d8f13a1e754618794bf42f417884940077b4ae/skills/scientific-visualization
  upstream-commit: 36d8f13a1e754618794bf42f417884940077b4ae
  adapted-by: EasyResearch
---

# Scientific Visualization

Adapted from K-Dense for EasyResearch's Figures-owned `figures/` root,
project-local dependencies, and platform-native shell policy.

## Routing

Use this Skill for empirical data visualizations: lines, points, intervals,
distributions, heatmaps, images, multi-panel comparisons, accessible color, or
export inspection. Use the sibling `drawio` and `drawio-academic-skills` for
architecture, workflow, roadmap, network, taxonomy, and replicated schematic
diagrams.

Require accepted data/result paths and enough evidence to define variables,
units, replicates, missingness, transformations, uncertainty, comparison groups,
and target medium. Never invent or manually improve values. If the evidence or a
consequential visual choice cannot be derived, return blocked through the caller
without asking the user directly.

## Artifact Boundary

All final plot artifacts stay under `figures/`:

```text
figures/
  .venv/                    # created only when a data-plot task needs packages
  <figure-name>.py          # reproducible source
  <figure-name>.provenance.json
  <figure-name>.pdf|svg|png|tiff|html
```

Temporary files may use a clearly named subdirectory under `figures/`. Do not
write plotting code or exports into experiment `results/`; read accepted results
there and preserve their paths in provenance. An explicitly supplied existing
layout may be followed only when the dispatch names it.

## Integrity Rules

- Preserve raw tables/images, exclusions, missing codes, analysis source,
  normalization, binning, image adjustments, and random seeds.
- Do not hide inconvenient observations, connect missing observations, treat
  missing as zero, upsample as new detail, or tune axes/dual axes to exaggerate.
- Name the estimator and uncertainty type: SD, SE, CI, percentile, posterior, or
  another declared interval. State `n` and the independent unit.
- Show raw observations when feasible and keep jitter from obscuring values.
- Bars/areas normally include zero; a nonzero point/line axis needs context and
  disclosure. Avoid decorative 3D and misleading area/radius encodings.
- Record log transforms, handling of zero/negative values, smoothing/binning,
  normalization, and sensitivity choices.
- Keep compared panels on compatible scales unless a difference is explicit.
- Preserve original images; disclose whole-image processing and add valid scale
  bars where applicable.
- Verify current venue rules from an official public source immediately before
  final delivery. A dated profile is planning guidance, not certification.

## Accessibility

- Use color plus marker, line style, hatching, direct label, or panel separation.
- Match qualitative, sequential, diverging, or cyclic palettes to data meaning.
- Inspect rendered contrast and grayscale separation at final physical size.
- Distinguish missing/censored/out-of-range values explicitly.
- Provide alt text/long description and underlying accessible data when the
  destination supports them.
- Interactive hover never replaces static labels, keyboard access, description,
  data table, or static fallback.

Read `references/color_palettes.md` and
`references/publication_guidelines.md` for the selected issue. Use
`references/journal_requirements.md` only as a dated snapshot and verify live
guidance. `references/sources.md` preserves upstream attribution/provenance.

## Project-Local Environment

Do not modify the global EasyResearch Skill venv. When a data plot needs Python
packages, create/reuse `figures/.venv` and install only the invoked subset:

```text
matplotlib==3.11.1
seaborn==0.13.2
plotly==6.9.0
kaleido==1.3.0
pillow==12.3.0
pypdf==6.14.2
```

Linux/macOS creation:

```bash
"$EASYRESEARCH_VENV/bin/python" -m venv figures/.venv
"figures/.venv/bin/python" -m pip install matplotlib==3.11.1 pillow==12.3.0 pypdf==6.14.2
```

Windows PowerShell:

```powershell
$basePython = Join-Path $env:EASYRESEARCH_VENV 'Scripts\python.exe'
& $basePython -m venv figures\.venv
$figurePython = Join-Path 'figures\.venv' 'Scripts\python.exe'
& $figurePython -m pip install matplotlib==3.11.1 pillow==12.3.0 pypdf==6.14.2
```

If the base interpreter, network, package wheel, or install authority is absent,
preserve source/planning work and return partial/blocked. Do not silently use a
global package or install Chrome. Record package versions in provenance and the
handoff. Set `MPLBACKEND=Agg` for noninteractive exports.

## Workflow

1. Record audience/medium, target venue/phase, intended physical width, data
   paths, variable semantics/units, replicate structure, missingness,
   transformations, estimator, and uncertainty.
2. Choose the most truthful encoding before styling. Prefer position on a common
   scale and aligned panels over dual axes.
3. Design color redundancy, labels, legend, caption inputs, and accessible
   description before rendering.
4. Write a reproducible plotting script under `figures/`. Use Matplotlib's
   object-oriented API and scoped style contexts; do not mutate global styles.
5. Export explicit formats/dimensions/background/font settings. Keep interactive
   and static outputs separate.
6. Write a provenance manifest naming raw/accepted data, transformations,
   exclusions, missing handling, uncertainty, seed, package versions, and
   source/export paths.
7. Inspect the actual exported file at final size and in manuscript context.
   Check clipping, labels, fonts, rasters, transparency, legends, scale bars,
   caption support, contrast, and source-data fidelity.
8. Recheck live venue guidance and report remaining manual checks honestly.

## Bundled Helpers

Use only helpers needed by the task:

- `scripts/image_metadata.py`: raster/SVG/PDF/EPS dimensions, DPI, mode, alpha,
  compression, page size, and conservative font metadata;
- `scripts/palette_audit.py`: exact contrast plus grayscale screening;
- `scripts/export_plan.py`: dated publisher export planning/screening;
- `scripts/style_presets.py`: inspect bundled styles/palettes;
- `scripts/style_preview.py`: create a local style sample;
- `scripts/figure_export.py`: atomic multi-format export and provenance manifest.

`pypdf` is used only to inspect a generated figure/export PDF. This Skill never
reads a manuscript PDF for Review.

Plotly/Kaleido are optional. Kaleido static export requires an already installed
compatible Chrome/Chromium; if absent, retain HTML and a Matplotlib/static
fallback or return partial. Never download a browser from this Skill.

## Completion

Complete when reproducible plot source, requested available exports, and a
provenance manifest exist under `figures/`; visual/data-integrity review passes;
and every value and transformation traces to accepted evidence. Apply
`specialist-handoff` and list all evidence, source, environment/provenance, and
export paths. Never claim accessibility or venue certification from an automated
report alone.
