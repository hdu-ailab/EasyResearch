import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// This harness runs only the candidate's extracted resource. Fault injection lives
// in the disposable Python process, never in the shipped publisher. Do not force
// WINDOWS here: each native release runner must exercise its actual OS behavior.
const probe = String.raw`
import json, os, platform, runpy, shutil, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

assert platform.python_implementation() == 'CPython'
assert sys.version_info[:2] == (3, 12), 'publisher smoke requires CPython 3.12'
assert shutil.which('node') is None, 'publisher environment resolves Node'
assert shutil.which('bun') is None, 'publisher environment resolves Bun'
publisher = Path(sys.argv[1]).resolve(strict=True)
assert publisher.is_file(), 'materialized publisher is missing'
root = Path.cwd()
payload = '# Native handoff\r\ncomplete: \u4e2d\u6587\n'.encode('utf-8')

# Exercise the real CLI, real fsync and native cleanup without any injection.
directory = root / 'handoffs'
directory.mkdir()
draft = directory / '.draft-cli.md'
draft.write_bytes(payload)
result = subprocess.run([
    sys.executable, '-I', '-B', str(publisher), '--directory', 'handoffs',
    '--prefix', 'search', '--source', 'handoffs/.draft-cli.md',
], capture_output=True, text=True, timeout=20)
assert result.returncode == 0, (result.returncode, result.stdout, result.stderr)
relative = Path(json.loads(result.stdout)['path'])
assert not relative.is_absolute() and relative.parent == Path('handoffs')
published = root / relative
assert published.read_bytes() == payload
assert published.stat().st_nlink == 1
assert list(directory.iterdir()) == [published], 'CLI left a draft/cleanup alias'

module = runpy.run_path(str(publisher))
publish = module['publish']
globals_ = publish.__globals__
assert globals_['WINDOWS'] == (os.name == 'nt'), 'publisher platform mismatch'
original_sync = os.fsync
flushes = []
def recording_sync(fd):
    original_sync(fd)
    flushes.append(fd)
os.fsync = recording_sync
try:
    # Freeze only the clock so both calls contend for precisely the same name.
    class FixedClock:
        @staticmethod
        def now(tz):
            return datetime(2026, 1, 2, 3, 4, 5, 6000, tzinfo=timezone.utc)
    globals_['datetime'] = FixedClock
    reviews = root / 'reviews'
    reviews.mkdir()
    first = reviews / '.draft-first.md'
    second = reviews / '.draft-second.md'
    first.write_bytes(payload)
    second.write_bytes(payload + b'second\n')
    first_path = root / publish('reviews/.draft-first.md', 'reviews', 'review_report')
    second_path = root / publish('reviews/.draft-second.md', 'reviews', 'review_report')
    assert first_path != second_path
    assert second_path.name == first_path.stem + '-01.md'
    assert first_path.read_bytes() == payload
    assert second_path.read_bytes() == payload + b'second\n'
    assert first_path.stat().st_nlink == second_path.stat().st_nlink == 1
    assert set(reviews.iterdir()) == {first_path, second_path}
    assert len(flushes) == 2, 'publication bypassed the real durability flush'

    # Native Windows renames to .cleanup-* before unlink; observe that exact
    # alias and permit rollback's final-name unlink to execute normally.
    failed_draft = directory / '.draft-rollback.md'
    failed_draft.write_bytes(payload + b'recoverable\n')
    before = set(directory.iterdir())
    original_unlink = os.unlink
    cleanup_attempts = []
    def failing_unlink(path, *args, **kwargs):
        name = Path(path).name
        if name.startswith(('.draft-', '.cleanup-')):
            cleanup_attempts.append(name)
            raise OSError('injected draft cleanup failure')
        return original_unlink(path, *args, **kwargs)
    os.unlink = failing_unlink
    try:
        try:
            publish('handoffs/.draft-rollback.md', 'handoffs', 'experiment')
        except RuntimeError as error:
            assert 'final link was rolled back' in str(error), str(error)
        else:
            raise AssertionError('cleanup failure reported success')
    finally:
        os.unlink = original_unlink
    assert len(cleanup_attempts) == 1, cleanup_attempts
    if os.name == 'nt':
        assert cleanup_attempts[0].startswith('.cleanup-'), cleanup_attempts
    else:
        assert cleanup_attempts == [failed_draft.name], cleanup_attempts
    assert len(flushes) == 3, 'cleanup probe did not reach a real flushed publication'
    assert set(directory.iterdir()) == before, 'rollback left a final/cleanup alias'
    assert failed_draft.read_bytes() == payload + b'recoverable\n'
    assert failed_draft.stat().st_nlink == 1
    assert published.read_bytes() == payload, 'rollback changed an earlier handoff'
finally:
    os.fsync = original_sync

print(json.dumps({
    'platform': sys.platform,
    'python': platform.python_version(),
    'checks': ['publication', 'collision', 'cleanup-rollback'],
    'cleanup': 'staged-alias' if os.name == 'nt' else 'draft',
}))
`;

/** Called only after compiled first-run setup and venv validation have succeeded. */
export function smokeImmutablePublisher(options: {
  bundledDir: string;
  python: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
}): void {
  mkdirSync(options.workspace, { recursive: true });
  const publisher = join(options.bundledDir, "skills", "specialist-handoff", "scripts", "publish_immutable.py");
  const result = spawnSync(options.python, ["-I", "-B", "-c", probe, publisher], {
    cwd: options.workspace,
    env: options.env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`materialized publisher smoke failed (${result.error?.message ?? result.status})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.platform, process.platform === "win32" ? "win32" : process.platform);
  assert.deepEqual(receipt.checks, ["publication", "collision", "cleanup-rollback"]);
  assert.equal(receipt.cleanup, process.platform === "win32" ? "staged-alias" : "draft");
  console.log(`[smoke] materialized publisher: ${JSON.stringify(receipt)}`);
}
