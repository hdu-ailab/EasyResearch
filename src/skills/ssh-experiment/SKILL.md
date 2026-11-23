---
name: ssh-experiment
description: |-
  Use when Experiment must work through a Research Assistant-verified SSH connection and exact-cwd experiment_ssh mount.
license: MIT
metadata:
  hermes:
    tags: [research, experiment, ssh, remote-compute, gpu]
    category: research
    related_skills: [experiment, remote-experiment-preflight]
---

# SSH Experiment Execution

## Boundary

Read `experiment` first. Use this Skill only after Research Assistant configured
the project's single `easyresearch.ssh` object and verified the SSHFS mapping.
Experiment may test and run the connection through `ssh-bash`; it must not
reconfigure host, port, username, authentication, credential files, or mounts.

Never read credential files with Agent-visible tools. `ssh-bash` reads their
contents inside the daemon and returns only remote command output.

## Freshness Guard

Before the first edit or launch, after reconnect, and after a long idle period:

1. call `ssh-bash` with `action: "test"`;
2. confirm exact-cwd `experiment_ssh/` remains the configured mount;
3. repeat the owner-only marker round trip through `ssh-bash run` and the local
   mount; and
4. query current compute availability.

If any check fails, preserve work and return `blocked`. Research Assistant must
repair/reconfigure the connection and mount before this child continues.

## Editing And Artifact Paths

Edit through the verified local mount using Read/Edit/Write:

```text
experiment_ssh/src/
experiment_ssh/external/
experiment_ssh/datasets/
experiment_ssh/outputs/
experiment_ssh/results/
experiment_ssh/logs/
experiment_ssh/experiment-record.md
```

This verified mount is the sole experiment root for SSH mode. Never create,
read, or write local-only `experiments/` during the remote task and never create
an `experiments/` child inside the mount. Keep raw/failed artifacts in
`outputs/`, formal promoted evidence in `results/`, and every command/status in
`experiment-record.md`.

## Remote Commands

Use only the configured tool:

```text
ssh-bash { action: "run", command: "<remote command>", background: true, timeout: <runtime-limit-in-milliseconds> }
```

The tool is cross-platform and provides managed remote Bash; do not
invoke `ssh`, `sshpass`, a POSIX wrapper, PowerShell remoting, or a second
executable. Commands execute on the configured server and are not confined by
the tool to the project root, so every experiment command must explicitly enter
the configured remote project root first. Use conservative shell quoting and put
free-form experiment values in reviewed config files on the mounted workspace
rather than interpolating paper text or user-authored shell fragments.

Record the exact command before launch. Long training commands use
`background: true` and a positive millisecond timeout matching the approved
runtime budget, for example `7200000` for an authorized two-hour run. Omitted or
zero background timeout is unlimited, not additional compute authority.
Foreground omitted/zero timeout waits two minutes, then backgrounds the same
remote operation without restarting it; a foreground timeout is a wait limit,
not a command runtime limit. Do not add `nohup`, `&`, or manual detachment.
A command shape is:

```text
remote_root='<configured-remote-experiment-root>' &&
case "$remote_root" in /*) ;; *) remote_root="$HOME/$remote_root" ;; esac &&
cd "$remote_root" && mkdir -p logs outputs &&
env CUDA_VISIBLE_DEVICES=<ids> uv run python src/train.py <reviewed-arguments>
```

Use the actual environment command when it differs from `uv` and record it.

## GPU Selection

Immediately before a GPU launch, run:

```text
nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv,noheader
```

Select only currently available GPUs compatible with the approved task. Set
`CUDA_VISIBLE_DEVICES` explicitly. Never assume a GPU model, count, fixed index,
CUDA version, or scheduler policy.

## Launch And Completion

Before launch:

- create a stable run id;
- record dataset, split, seed, metrics, command, output/log paths, and expected
  resources;
- ensure raw output goes to `outputs/<run-id>/` and logs to `logs/`; and
- run a short smoke trial when code or environment changed.

The managed result returns a shell ID while work is running. Full combined
output is captured to an owned file; completion is delivered automatically to
the owning Agent with a bounded preview and the exit outcome. Do independent
useful work or end the response for automatic wakeup. Do not sleep, poll logs or
status, or start another copy while waiting. After the completion notice, inspect
the selected-root artifacts and update `experiment-record.md` before another run.

Task cancellation requests TERM on the SSH channel and closes the connection
with bounded cleanup. Remote descendants that escape that channel may survive;
do not claim whole-server process-tree termination. SSH connections do not survive
daemon shutdown/restart. Treat a lost connection as interrupted work and inspect
actual remote artifacts/ownership before deciding whether a new launch is needed;
local process-worker handover does not apply to SSH.

A PID or quiet log is not proof of success. Verify exit/status evidence and
expected outputs, then promote only reproducible formal artifacts to `results/`.

## Blocked Outcome

Stop on stale connection/mount identity, unavailable approved compute, missing
remote permissions, uncertain scheduler ownership, or any need to change
`easyresearch.ssh`. Return preserved artifacts, the failed check, safe
diagnostics, and one user-owned `required_user_input`, or `none` when no user
action can resolve the failure.
