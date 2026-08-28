import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const python = process.env.EASYRESEARCH_SMOKE_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runPython(args: string[], cwd = projectRoot, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(python, args, { cwd, env: { ...env, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" });
}

function runPythonAsync(args: string[], cwd: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(python, args, {
      cwd,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

describe("adapted Skill helper boundaries", () => {
  it("publishes concurrent drafts to distinct immutable timestamped paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "easyresearch-handoff-helper-"));
    tempRoots.push(root);
    mkdirSync(join(root, "handoffs"));
    writeFileSync(join(root, "handoffs", ".draft-a.md"), "first\n", "utf8");
    writeFileSync(join(root, "handoffs", ".draft-b.md"), "second\n", "utf8");
    const script = join(projectRoot, "src", "skills", "specialist-handoff", "scripts", "publish_immutable.py");

    const [first, second] = await Promise.all([
      runPythonAsync([script, "--directory", "handoffs", "--prefix", "search", "--source", "handoffs/.draft-a.md"], root),
      runPythonAsync([script, "--directory", "handoffs", "--prefix", "search", "--source", "handoffs/.draft-b.md"], root),
    ]);

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    const firstPath = JSON.parse(first.stdout).path as string;
    const secondPath = JSON.parse(second.stdout).path as string;
    expect(firstPath).not.toBe(secondPath);
    expect(firstPath).toMatch(/^handoffs\/search-\d{8}-\d{6}-\d{3}(?:-\d{2})?\.md$/);
    expect(secondPath).toMatch(/^handoffs\/search-\d{8}-\d{6}-\d{3}(?:-\d{2})?\.md$/);
    expect(new Set([readFileSync(join(root, firstPath), "utf8"), readFileSync(join(root, secondPath), "utf8")])).toEqual(
      new Set(["first\n", "second\n"]),
    );
    expect(existsSync(join(root, "handoffs", ".draft-a.md"))).toBe(false);
    expect(existsSync(join(root, "handoffs", ".draft-b.md"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("rejects a symlink draft without deleting its target", () => {
    const root = mkdtempSync(join(tmpdir(), "easyresearch-handoff-symlink-"));
    tempRoots.push(root);
    mkdirSync(join(root, "handoffs"));
    writeFileSync(join(root, "handoffs", ".draft-real.md"), "real\n", "utf8");
    symlinkSync(".draft-real.md", join(root, "handoffs", ".draft-link.md"));
    const script = join(projectRoot, "src", "skills", "specialist-handoff", "scripts", "publish_immutable.py");

    const result = runPython([
      script,
      "--directory",
      "handoffs",
      "--prefix",
      "search",
      "--source",
      "handoffs/.draft-link.md",
    ], root);

    expect(result.status).toBe(1);
    expect(readFileSync(join(root, "handoffs", ".draft-real.md"), "utf8")).toBe("real\n");
    expect(readdirSync(join(root, "handoffs")).filter((name) => name.startsWith("search-"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("fails closed when the draft pathname is replaced during publication", () => {
    const script = join(projectRoot, "src", "skills", "specialist-handoff", "scripts", "publish_immutable.py");
    const probe = [
      "import os, runpy, tempfile",
      "from pathlib import Path",
      `m = runpy.run_path(${JSON.stringify(script)})`,
      "root = Path(tempfile.mkdtemp())",
      "os.chdir(root)",
      "directory = root / 'handoffs'",
      "directory.mkdir()",
      "draft = directory / '.draft-search-test.md'",
      "original = directory / '.draft-original.md'",
      "draft.write_text('original\\n', encoding='utf-8')",
      "original_link = os.link",
      "def swapping_link(source, destination, *args, **kwargs):",
      "    draft.rename(original)",
      "    draft.write_text('replacement\\n', encoding='utf-8')",
      "    return original_link(source, destination, *args, **kwargs)",
      "m['os'].link = swapping_link",
      "try:",
      "    m['publish']('handoffs/.draft-search-test.md', 'handoffs', 'search')",
      "except (OSError, RuntimeError, ValueError):",
      "    pass",
      "else:",
      "    raise AssertionError('replacement draft was published')",
      "assert original.read_text(encoding='utf-8') == 'original\\n'",
      "assert draft.read_text(encoding='utf-8') == 'replacement\\n'",
      "assert not list(directory.glob('search-*.md'))",
    ].join("\n");

    const result = runPython(["-c", probe]);

    expect(result.status, result.stderr).toBe(0);
  });

  it.skipIf(process.platform === "win32")("fails closed when the destination directory is replaced during publication", () => {
    const script = join(projectRoot, "src", "skills", "specialist-handoff", "scripts", "publish_immutable.py");
    const probe = [
      "import os, runpy, tempfile",
      "from pathlib import Path",
      `m = runpy.run_path(${JSON.stringify(script)})`,
      "root = Path(tempfile.mkdtemp())",
      "os.chdir(root)",
      "directory = root / 'handoffs'",
      "moved = root / 'handoffs-original'",
      "outside = root / 'outside'",
      "directory.mkdir()",
      "outside.mkdir()",
      "draft = directory / '.draft-search-test.md'",
      "draft.write_text('original\\n', encoding='utf-8')",
      "original_link = os.link",
      "def swapping_link(source, destination, *args, **kwargs):",
      "    directory.rename(moved)",
      "    directory.symlink_to(outside, target_is_directory=True)",
      "    (outside / draft.name).write_text('replacement\\n', encoding='utf-8')",
      "    return original_link(source, destination, *args, **kwargs)",
      "m['os'].link = swapping_link",
      "try:",
      "    m['publish']('handoffs/.draft-search-test.md', 'handoffs', 'search')",
      "except (OSError, RuntimeError, ValueError):",
      "    pass",
      "else:",
      "    raise AssertionError('replacement directory was published through')",
      "assert (moved / draft.name).read_text(encoding='utf-8') == 'original\\n'",
      "assert not list(moved.glob('search-*.md'))",
      "assert not list(outside.glob('search-*.md'))",
    ].join("\n");

    const result = runPython(["-c", probe]);

    expect(result.status, result.stderr).toBe(0);
  });

  it("closes the pinned draft before Windows-style cleanup", () => {
    const script = join(projectRoot, "src", "skills", "specialist-handoff", "scripts", "publish_immutable.py");
    const probe = [
      "import os, runpy, tempfile",
      "from pathlib import Path",
      `m = runpy.run_path(${JSON.stringify(script)})`,
      "root = Path(tempfile.mkdtemp())",
      "os.chdir(root)",
      "directory = root / 'handoffs'",
      "directory.mkdir()",
      "draft = directory / '.draft-search-test.md'",
      "draft.write_text('complete\\n', encoding='utf-8')",
      "opened = []",
      "original_open = os.open",
      "def recording_open(path, *args, **kwargs):",
      "    descriptor = original_open(path, *args, **kwargs)",
      "    if Path(path).name == draft.name: opened.append(descriptor)",
      "    return descriptor",
      "m['os'].open = recording_open",
      "globals_ = m['publish'].__globals__",
      "globals_['WINDOWS'] = True",
      "globals_['_relative_operations_supported'] = lambda: False",
      "original_remove = globals_['_remove_entry']",
      "def checking_remove(path, name, directory_fd):",
      "    try:",
      "        os.fstat(opened[-1])",
      "    except OSError:",
      "        pass",
      "    else:",
      "        raise AssertionError('source descriptor remained open during cleanup')",
      "    return original_remove(path, name, directory_fd)",
      "globals_['_remove_entry'] = checking_remove",
      "published = m['publish']('handoffs/.draft-search-test.md', 'handoffs', 'search')",
      "assert (root / published).read_text(encoding='utf-8') == 'complete\\n'",
      "assert not draft.exists()",
    ].join("\n");

    const result = runPython(["-c", probe]);

    expect(result.status, result.stderr).toBe(0);
  });

  it("rolls back the final link when draft cleanup fails", () => {
    const script = join(projectRoot, "src", "skills", "specialist-handoff", "scripts", "publish_immutable.py");
    const probe = [
      "import os, runpy, tempfile",
      "from pathlib import Path",
      `m = runpy.run_path(${JSON.stringify(script)})`,
      "root = Path(tempfile.mkdtemp())",
      "os.chdir(root)",
      "(root / 'handoffs').mkdir()",
      "draft = root / 'handoffs' / '.draft-search-test.md'",
      "draft.write_text('complete\\n', encoding='utf-8')",
      "original_unlink = os.unlink",
      "def failing_unlink(path, *args, **kwargs):",
      "    if Path(path).name == draft.name: raise OSError('injected cleanup failure')",
      "    return original_unlink(path, *args, **kwargs)",
      "m['os'].unlink = failing_unlink",
      "try:",
      "    m['publish']('handoffs/.draft-search-test.md', 'handoffs', 'search')",
      "except RuntimeError:",
      "    pass",
      "else:",
      "    raise AssertionError('cleanup failure was reported as success')",
      "assert draft.exists()",
      "assert not list((root / 'handoffs').glob('search-*.md'))",
    ].join("\n");

    const result = runPython(["-c", probe]);

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    "api_key",
    "access_token",
    "accessToken",
    "client_secret",
    "clientSecret",
    "authorization",
    "refresh-token",
    "refreshToken",
    "x-api-key",
    "xApiKey",
  ])(
    "rejects paper lookup credential parameter %s without echoing its value",
    (parameter) => {
      const script = join(projectRoot, "src", "skills", "paper-lookup", "scripts", "paginate.py");
      const result = runPython([
        script,
        "--api",
        "openalex",
        "--query",
        `search=crispr&${parameter}=SECRET_TEST_KEY`,
        "--dry-run",
      ]);

      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("SECRET_TEST_KEY");
      expect(result.stderr).not.toContain("SECRET_TEST_KEY");
    },
  );

  it.each([
    ["--max-records", "1001"],
    ["--max-calls", "51"],
  ])("rejects paper lookup requests above the hard %s cap", (option, value) => {
    const script = join(projectRoot, "src", "skills", "paper-lookup", "scripts", "paginate.py");
    const result = runPython([
      script,
      "--api",
      "openalex",
      "--query",
      "search=crispr",
      option,
      value,
      "--dry-run",
    ]);

    expect(result.status).toBe(1);
  });

  it("bounds a paper lookup response before decoding JSON", () => {
    const script = join(projectRoot, "src", "skills", "paper-lookup", "scripts", "paginate.py");
    const probe = [
      "import runpy",
      `m = runpy.run_path(${JSON.stringify(script)})`,
      "class Response:",
      "    def __enter__(self): return self",
      "    def __exit__(self, *args): return False",
      "    def read(self, size):",
      "        assert size == m['MAX_RESPONSE_BYTES'] + 1",
      "        return b'x' * size",
      "m['urllib'].request.urlopen = lambda request, timeout: Response()",
      "try:",
      "    m['fetch']('https://example.test')",
      "except RuntimeError as error:",
      "    assert 'response exceeded' in str(error)",
      "else:",
      "    raise AssertionError('oversized response was accepted')",
    ].join("\n");
    const result = runPython(["-c", probe]);

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([String.raw`..\outside.csv`, String.raw`C:\outside.csv`])(
    "rejects Windows traversal evidence paths: %s",
    (unsafePath) => {
      const script = join(
        projectRoot,
        "src",
        "skills",
        "hypothesis-generation",
        "scripts",
        "validate_hypothesis_schema.py",
      );
      const probe = [
        "import runpy, sys",
        `sys.path.insert(0, ${JSON.stringify(resolve(script, ".."))})`,
        `m = runpy.run_path(${JSON.stringify(script)})`,
        `value = {'ledger_path': ${JSON.stringify(unsafePath)}, 'source_ids': ['SRC-1'], 'search_boundary_id': 'BOUNDARY-1', 'evidence_limitations': ['Known coverage limitation']}`,
        "try:",
        "    m['_parse_evidence'](value)",
        "except m['ValidationError']:",
        "    pass",
        "else:",
        "    raise AssertionError('unsafe Windows path was accepted')",
      ].join("\n");
      const result = runPython(["-c", probe]);

      expect(result.status, result.stderr).toBe(0);
    },
  );

  it("accepts explicitly authorized configured-provider review processing", () => {
    const root = mkdtempSync(join(tmpdir(), "easyresearch-review-intake-"));
    tempRoots.push(root);
    const templatePath = join(projectRoot, "src", "skills", "peer-review", "assets", "review_intake_template.json");
    const intake = JSON.parse(readFileSync(templatePath, "utf8"));
    intake.authorization.documented = true;
    intake.authorization.local_processing_authorized = true;
    intake.authorization.external_processing_authorized = true;
    intake.reviewer.human_accountable = true;
    intake.reviewer.conflict_status = "none_identified";
    intake.venue_policy.checked = true;
    intake.venue_policy.peer_review_model = "double_anonymized";
    intake.ai_use.policy = "permitted_with_disclosure";
    intake.ai_use.planned = "approved_ai_assistance";
    intake.ai_use.permission_confirmed = true;
    intake.ai_use.disclosure_planned = true;
    intake.handling.local_only = false;
    intake.handling.external_service_use = true;
    intake.handling.retention_rule = "retain_per_venue_policy";
    intake.handling.deletion_or_retention_record_planned = true;
    const intakePath = join(root, "intake.json");
    writeFileSync(intakePath, JSON.stringify(intake), "utf8");
    const script = join(projectRoot, "src", "skills", "peer-review", "scripts", "validate_review_intake.py");

    const result = runPython([script, intakePath]);

    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("READY_FOR_DECLARED_REVIEW");
    expect(report.handling_assertions.external_service_use_declared_authorized).toBe(true);
    expect(report.handling_assertions.bundled_tools_are_local_only).toBe(false);
  });

  it("lints an owner-assigned ADR-102 review report without editor channels", () => {
    const root = mkdtempSync(join(tmpdir(), "easyresearch-review-lint-"));
    tempRoots.push(root);
    const reportPath = join(root, "review.md");
    writeFileSync(
      reportPath,
      [
        "# Review Report",
        "",
        "## Review Scope And Inputs",
        "Authorized Markdown source and experiment evidence were reviewed.",
        "",
        "## Major Findings",
        "",
        "### Major finding M1",
        "- Location: manuscript/manuscript.md, Method",
        "- Observation: The analysis unit is not defined.",
        "- Evidence or criterion: experiment_ssh/experiment-record.md records subject-level repeats.",
        "- Why it matters: Independence and uncertainty cannot be assessed.",
        "- Required action: Define the independent unit and revise the analysis.",
        "- Owner: Experiment",
        "",
        "## Minor Findings",
        "none",
        "",
        "## Unreviewed Areas And Limitations",
        "Final PDF rendering was not reviewed.",
      ].join("\n"),
      "utf8",
    );
    const script = join(projectRoot, "src", "skills", "peer-review", "scripts", "lint_review.py");

    const result = runPython([script, reportPath]);

    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.valid).toBe(true);
    expect(report.structured_finding_count).toBe(1);
  });

  it("keeps one-sided zero-correlation rejection probability at alpha", () => {
    const script = join(projectRoot, "src", "skills", "statistical-power", "scripts", "power.py");
    const probe = [
      "import math, runpy, sys, types",
      "from statistics import NormalDist",
      "numpy = types.ModuleType('numpy')",
      "sys.modules['numpy'] = numpy",
      "statsmodels = types.ModuleType('statsmodels')",
      "statsmodels.__path__ = []",
      "stats_pkg = types.ModuleType('statsmodels.stats')",
      "stats_pkg.__path__ = []",
      "power_pkg = types.ModuleType('statsmodels.stats.power')",
      "proportion_pkg = types.ModuleType('statsmodels.stats.proportion')",
      "for name in ('FTestAnovaPower', 'GofChisquarePower', 'NormalIndPower', 'TTestIndPower', 'TTestPower'): setattr(power_pkg, name, object)",
      "proportion_pkg.proportion_effectsize = lambda first, second: first - second",
      "sys.modules['statsmodels'] = statsmodels",
      "sys.modules['statsmodels.stats'] = stats_pkg",
      "sys.modules['statsmodels.stats.power'] = power_pkg",
      "sys.modules['statsmodels.stats.proportion'] = proportion_pkg",
      "class Norm:",
      "    @staticmethod",
      "    def cdf(value): return NormalDist().cdf(value)",
      "    @staticmethod",
      "    def ppf(value): return NormalDist().inv_cdf(value)",
      "scipy = types.ModuleType('scipy')",
      "scipy.stats = types.SimpleNamespace(norm=Norm())",
      "sys.modules['scipy'] = scipy",
      `m = runpy.run_path(${JSON.stringify(script)})`,
      "assert abs(m['_corr_power'](0.0, 100, 0.05, 'larger') - 0.05) < 1e-12",
      "assert abs(m['_corr_power'](0.0, 100, 0.05, 'smaller') - 0.05) < 1e-12",
      "assert m['mde']('correlation', nobs=100, alternative='smaller') < 0",
    ].join("\n");

    const result = runPython(["-c", probe]);

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects an unreachable regression target before scanning every sample size", () => {
    const script = join(projectRoot, "src", "skills", "statistical-power", "scripts", "power.py");
    const probe = [
      "import runpy, sys, types",
      "sys.modules['numpy'] = types.ModuleType('numpy')",
      "statsmodels = types.ModuleType('statsmodels')",
      "statsmodels.__path__ = []",
      "stats_pkg = types.ModuleType('statsmodels.stats')",
      "stats_pkg.__path__ = []",
      "power_pkg = types.ModuleType('statsmodels.stats.power')",
      "proportion_pkg = types.ModuleType('statsmodels.stats.proportion')",
      "for name in ('FTestAnovaPower', 'GofChisquarePower', 'NormalIndPower', 'TTestIndPower', 'TTestPower'): setattr(power_pkg, name, object)",
      "proportion_pkg.proportion_effectsize = lambda first, second: first - second",
      "sys.modules['statsmodels'] = statsmodels",
      "sys.modules['statsmodels.stats'] = stats_pkg",
      "sys.modules['statsmodels.stats.power'] = power_pkg",
      "sys.modules['statsmodels.stats.proportion'] = proportion_pkg",
      `m = runpy.run_path(${JSON.stringify(script)})`,
      "calls = []",
      "def unreachable(f2, n, df_num, k_total, alpha):",
      "    calls.append(n)",
      "    return 0.0",
      "m['_reg_sample_size'].__globals__['_reg_power'] = unreachable",
      "try:",
      "    m['_reg_sample_size'](1e-9, 1, 1, 0.05, 0.99)",
      "except RuntimeError:",
      "    pass",
      "else:",
      "    raise AssertionError('unreachable target was accepted')",
      "assert calls[0] == 1_000_000, calls[:3]",
      "assert len(calls) <= 2, len(calls)",
    ].join("\n");

    const result = runPython(["-c", probe]);

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects fractional randomization allocation ratios", () => {
    const script = join(projectRoot, "src", "skills", "experimental-design", "scripts", "randomization.py");
    const probe = [
      "import runpy, sys, types",
      "sys.modules['numpy'] = types.ModuleType('numpy')",
      "sys.modules['pandas'] = types.ModuleType('pandas')",
      `m = runpy.run_path(${JSON.stringify(script)})`,
      "try:",
      "    m['_normalize_ratio'](['A', 'B'], [1.5, 1])",
      "except ValueError:",
      "    pass",
      "else:",
      "    raise AssertionError('fractional ratio was accepted')",
    ].join("\n");

    const result = runPython(["-c", probe]);

    expect(result.status, result.stderr).toBe(0);
  });

  it("fails a raster below a publisher target DPI", () => {
    const script = join(projectRoot, "src", "skills", "scientific-visualization", "scripts", "export_plan.py");
    const scriptsDir = resolve(script, "..");
    const probe = [
      "import runpy, sys, types",
      `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
      "image_metadata = types.ModuleType('image_metadata')",
      "image_metadata.inspect_file = lambda path: {'input': {'size_bytes': 100}, 'metadata': {'kind': 'raster', 'format': 'PNG', 'width_px': 300, 'height_px': 300, 'mode': 'RGB', 'has_alpha': False}}",
      "sys.modules['image_metadata'] = image_metadata",
      `m = runpy.run_path(${JSON.stringify(script)})`,
      "plan = {'formats': ['png'], 'width': {'millimeters': 85.0}, 'raster_dpi': {'target': 300.0}, 'max_height_mm': None, 'max_file_bytes': None, 'max_file_bytes_exclusive': None, 'width_range_px_at_300_dpi': None, 'color_modes': None}",
      "report = m['validate_against_plan'](plan, 'synthetic.png')",
      "finding = next(item for item in report['findings'] if item['name'] == 'effective_raster_dpi')",
      "assert finding['status'] == 'fail', finding",
    ].join("\n");

    const result = runPython(["-c", probe]);

    expect(result.status, result.stderr).toBe(0);
  });

  it("builds only bounded public Hugging Face Dataset Viewer URLs", () => {
    const script = join(projectRoot, "src", "skills", "huggingface-datasets", "scripts", "dataset_viewer_url.py");
    const valid = runPython([
      script,
      "--endpoint",
      "rows",
      "--dataset",
      "stanfordnlp/imdb",
      "--revision",
      "main",
      "--config",
      "plain_text",
      "--split",
      "train",
      "--offset",
      "0",
      "--length",
      "100",
    ]);
    expect(valid.status, valid.stderr).toBe(0);
    const payload = JSON.parse(valid.stdout);
    expect(payload.method).toBe("GET");
    expect(payload.source).toBe("dataset-viewer");
    expect(payload.requested_revision).toBe("main");
    expect(payload.revision_selectable).toBe(false);
    expect(payload.revision_url).toBe("https://huggingface.co/api/datasets/stanfordnlp/imdb/revision/main");
    expect(payload.url).toContain("https://datasets-server.huggingface.co/rows?");
    expect(payload.url).not.toMatch(/token|authorization/i);

    const croissant = runPython([
      script,
      "--endpoint",
      "croissant",
      "--dataset",
      "stanfordnlp/imdb",
      "--revision",
      "main",
    ]);
    expect(croissant.status, croissant.stderr).toBe(0);
    const croissantPayload = JSON.parse(croissant.stdout);
    expect(croissantPayload.source).toBe("hub-croissant");
    expect(croissantPayload.revision_selectable).toBe(false);
    expect(croissantPayload.url).toBe("https://huggingface.co/api/datasets/stanfordnlp/imdb/croissant");

    const oversized = runPython([
      script,
      "--endpoint",
      "rows",
      "--dataset",
      "stanfordnlp/imdb",
      "--revision",
      "main",
      "--config",
      "plain_text",
      "--split",
      "train",
      "--length",
      "101",
    ]);
    expect(oversized.status).toBe(1);
  });

  it("points missing visualization packages to figures/.venv", () => {
    const script = join(projectRoot, "src", "skills", "scientific-visualization", "scripts", "figure_export.py");
    const scriptsDir = resolve(script, "..");
    const probe = [
      "import builtins, runpy, sys, tempfile",
      "from pathlib import Path",
      `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
      `m = runpy.run_path(${JSON.stringify(script)})`,
      "root = Path(tempfile.mkdtemp())",
      "(root / 'figures').mkdir()",
      "original_import = builtins.__import__",
      "def blocked_import(name, *args, **kwargs):",
      "    if name == 'matplotlib': raise ImportError('blocked for test')",
      "    return original_import(name, *args, **kwargs)",
      "builtins.__import__ = blocked_import",
      "try:",
      "    m['export_figure'](None, root / 'figures' / 'plot', formats=['png'])",
      "except m['CliError'] as error:",
      "    assert 'figures/.venv' in str(error), error",
      "else:",
      "    raise AssertionError('missing Matplotlib was accepted')",
    ].join("\n");

    const result = runPython(["-c", probe]);

    expect(result.status, result.stderr).toBe(0);
  });
});
