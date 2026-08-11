---
name: ssh-experiment
description: |-
  Run GPU-intensive deep learning experiments on a remote SSH server ({{SSH_HOST}},
  3x RTX3090-24G example). Check GPU availability via nvidia-smi before launching,
  select free GPUs with CUDA_VISIBLE_DEVICES, mount the server home via sshfs if
  needed. Use proactively when user needs image recognition, deep learning, or any
  task requiring GPU acceleration.

  Examples:
  - user: "Train this CNN on CIFAR-10" → check GPU, select free GPU, run via ssh
  - user: "Run hyperparameter grid search" → distribute trials across available GPUs
  - user: "Check GPU usage on server" → ssh nvidia-smi, report free GPUs
  - user: "Mount server home" → sshfs {{SSH_USER}}@{{SSH_HOST}}: {{SSHFS_MOUNT}}
---

# SSH Experiment Server

** MAKE SURE YOU HAVE READ `experiment` SKILL BEFORE CONNECTING TO REMOTE SERVER **

## Placeholders

This is a sanitized template. Replace every `{{TOKEN}}` with your own values before first use (your global copy at `~/.easyresearch/agent/skills/ssh-experiment/` is never overwritten by startup).

| Token | Meaning | Generic example |
|-------|---------|-----------------|
| `{{SSH_HOST}}` | SSH server hostname or alias | `your-server-alias` |
| `{{SSH_USER}}` | SSH login username | `your-username` |
| `{{SSH_PRIMARY_HOST}}` | Primary LAN host for primary-first connection | `192.168.0.x` |
| `{{SSHFS_MOUNT}}` | Local directory where the server home is sshfs-mounted | `~/server-mount` |

## Server Info

| Item | Value |
|------|-------|
| GPUs | 3x NVIDIA RTX 3090 (24576 MiB each) |
| CUDA | 12.4, Driver 550.144.03 |
| Local mount | `{{SSHFS_MOUNT}}/` |
| uv | `~/.local/bin/uv` — PATH configured via `~/.bashrc`, works in both interactive and non-interactive SSH |

## Quick Commands

```bash
# rssh is added in PATH, you can use it directly
rssh

# Check GPU status
rssh "nvidia-smi"

# Launch experiment with log (returns immediately)
rssh -f "cd ~/workspace/experiments && CUDA_VISIBLE_DEVICES=1 uv run python src/train.py --epochs 200 > logs/<run-id>.log 2>&1"

# Mount if {{SSHFS_MOUNT}} is empty
sshfs {{SSH_USER}}@{{SSH_HOST}}: {{SSHFS_MOUNT}}
```

Edit code, check logs — use Read/Edit/Write tools on `{{SSHFS_MOUNT}}/workspace/experiments/` (no SSH).

**All SSH to {{SSH_HOST}} MUST use `rssh`** (`.opencode/skills/ssh-experiment/scripts/rssh`). This wrapper adds keepalive (`ServerAliveInterval=30`, `ServerAliveCountMax=10`) and timeout handling to prevent connection drops. Use `-f` to launch background jobs that return immediately.

For interactive sessions, use `rssh-tmux`.

## Mount Check

Before any server operation, verify `{{SSHFS_MOUNT}}/` is mounted — use Read tool on the directory. If it returns empty or only `.` and `..`, mount it:

```bash
sshfs {{SSH_USER}}@{{SSH_HOST}}: {{SSHFS_MOUNT}}
```

The mount is a direct SSHFS mirror of the remote home directory. Files written here appear on the server and vice versa.

## Local vs Remote: Core Principle

**The mount is sshfs-mounted** → all files are accessible locally. Only TWO things go through SSH:

| Action | Where | How |
|--------|-------|-----|
| Edit code, write files | **Local** | Use Edit/Write tools on `{{SSHFS_MOUNT}}/workspace/experiments/src/` |
| Read logs, check outputs | **Local** | Use Read tool on `{{SSHFS_MOUNT}}/workspace/experiments/logs/` |
| Compile PDF, LaTeX | **Local** | latexmk on local path |
| Run `python` scripts | **Server via SSH** | `rssh -f "cd ~/workspace/experiments && CUDA_VISIBLE_DEVICES=1 uv run python src/train.py"` |
| nvidia-smi, GPU check | **Server via SSH** | `rssh "nvidia-smi"` |
| Install packages in server venv | **Server via SSH** | `rssh "cd ~/workspace/experiments && uv pip install ..."` |
| mkdir, file ops on server | **Either** | Local writes appear on server via sshfs; SSH also works |

## GPU Selection Protocol

Before launching any GPU job:

1. **Check GPU usage:**
   ```bash
   rssh "nvidia-smi --query-gpu=index,memory.used,memory.total,utilization.gpu --format=csv,noheader"
   ```

2. **Select free GPU(s):** pick GPUs with minimal memory usage. Usually GPU 0 has desktop processes (Xorg, gnome-shell), prefer GPU 1 and 2.

3. **Set CUDA_VISIBLE_DEVICES** in the job command:
   ```bash
   rssh -f "cd ~/workspace/experiments && CUDA_VISIBLE_DEVICES=1 uv run python src/train.py"
   ```

4. **Multi-GPU:** when using multiple GPUs, list them comma-separated:
   ```bash
   rssh -f "cd ~/workspace/experiments && CUDA_VISIBLE_DEVICES=1,2 uv run python -m torch.distributed.launch src/train.py"
   ```

## Running Experiments

**Workflow**: write/edit code locally → launch via `rssh -f` → poll logs locally until done.

### 1. Write code locally

Use Edit/Write tools on `{{SSHFS_MOUNT}}/workspace/experiments/src/` — mirrored to server instantly via sshfs.

### 2. Launch on server

Use `rssh -f` with log redirection (returns immediately):

```bash
rssh -f "cd ~/workspace/experiments && CUDA_VISIBLE_DEVICES=<gpu_id> uv run python src/train.py --epochs 200 > logs/<run-id>.log 2>&1"
```

For short debugging runs, use `rssh` without `-f`:

```bash
rssh "cd ~/workspace/experiments && CUDA_VISIBLE_DEVICES=<gpu_id> uv run python src/train.py --epochs 2 2>&1 | tee logs/<run-id>.log"
```

### 3. Poll and monitor

After launching, poll logs **locally** (no SSH) with this adaptive sleep schedule:

1. **Launch + sleep 60s** — quick sanity check that the process started.
2. **Read log locally** — use Read tool or `cat` on the mounted path. NO SSH needed:
   ```
   cat {{SSHFS_MOUNT}}/workspace/.../logs/<run-id>.log
   ```
   Check for: epoch progress, loss values, ETA, errors, or completion markers.
3. **If running normally → sleep 1h**, then read log again.
4. **Assess progress**: compare elapsed epochs vs total epochs. 
   - If progress is far from done (e.g. < 30%), extend sleep to 2h+.
   - If near completion (e.g. > 80%), sleep shorter (15-30min).
5. **Repeat** until log shows completion (e.g. "training finished", final metrics printed) or error.

```bash
# Check if process is still running (this IS SSH — pgrep is server-side)
rssh "pgrep -f 'uv run python src/train.py' && echo running || echo done"
```

If the process died early, check the log for errors. If it completed, promote outputs to `results/`.

### 4. Interactive monitoring (when needed)

For interactive inspection of a running job, use `rssh-tmux`:

```bash
# One-time setup: start persistent SSH session
rssh-tmux start

# Send commands to the running session  
rssh-tmux send "nvidia-smi"
rssh-tmux send "tail -f ~/workspace/experiments/logs/<run-id>.log"

# Capture last 100 lines of output
rssh-tmux capture 100

# Stop when done
rssh-tmux stop
```
