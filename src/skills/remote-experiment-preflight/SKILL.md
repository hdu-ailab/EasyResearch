---
name: remote-experiment-preflight
description: |-
  Use when an empirical paper task will run on one SSH server and the Research Assistant must prepare and verify its remote workspace before dispatching Experiment.
license: MIT
metadata:
  hermes:
    tags: [research, ssh, remote-experiment, preflight, sshfs, gpu]
    category: research
    related_skills: [research-project-workflow, experiment, ssh-experiment]
---

# Remote Experiment Preflight

## Boundary

This is the Research Assistant's narrow infrastructure exception. Configure and
test one SSH server, inspect its compute, and establish a user-authorized mount.
Do not write experiment code, install experiment dependencies, launch trials, or
interpret results.

The first version supports exactly one server per project through
`easyresearch.ssh`. Do not create profile names, a server list, selection logic,
or compatibility fields for future multi-server support.

## Required Values

Derive these from the conversation or ask one focused question for missing
values:

- host or IP address;
- port;
- username;
- expected SSH host fingerprint in OpenSSH `SHA256:<base64>` form, obtained
  from the server owner or another trusted channel;
- authentication type: `password` or `private-key`;
- absolute credential-file path outside the paper project;
- optional absolute passphrase-file path for an encrypted private key;
- paper or project name, unless the user supplied an absolute POSIX remote
  project path;
- expected compute class and mount authority.

The credential file is user-managed. For `password`, its first line is the
password. For `private-key`, it contains the OpenSSH private key. File contents
must never be read with Agent-visible tools, copied into chat, written to
settings/artifacts, or included in diagnostics. Only paths may enter the
conversation and project settings.

## Workspace Mapping

The local SSH experiment root is always the absolute
`<exact-cwd>/experiment_ssh/`. Do not ask the user to choose another local path
and do not mount an SSH workspace over local-only `experiments/`.

Select the remote project root in this order:

1. Use an absolute POSIX path when the user explicitly supplied one.
2. Otherwise derive a short project name from the approved paper title, project
   name, existing project artifacts, or exact-cwd basename, in that order.
3. Convert that name to one lowercase conservative ASCII slug: translate a
   non-ASCII title to a concise meaningful English name when needed, replace
   each run outside `a-z`, `0-9`, `.`, `_`, and `-` with one `-`, collapse
   repeated `-`, and trim punctuation from both ends. If no non-empty meaningful
   slug remains, ask for the project name, not a server path.
4. Configure the home-relative remote root as `<slug>/`, which means
   `$HOME/<slug>/` for creation, commands, and SSHFS.

The configured mapping is therefore either an explicit
`/absolute/remote/path -> <exact-cwd>/experiment_ssh/` or the default
`$HOME/<slug>/ -> <exact-cwd>/experiment_ssh/`. Reuse a previously accepted
exact mapping for this project; do not silently rename it on a later turn.

## Configure And Test

Call `ssh-bash` with `action: "configure"`, all connection fields, the selected
absolute or home-relative `remoteExperimentRoot`, and the absolute
`<exact-cwd>/experiment_ssh` `localMountPath`. The tool:

1. validates the single-server schema and credential paths;
2. rejects a server whose presented host key does not match the supplied
   fingerprint before authentication;
3. reads credential contents only inside the daemon;
4. runs a bounded remote `true` command;
5. persists `easyresearch.ssh` only after success; and
6. returns no credential path or content.

On failure, report the safe diagnostic immediately and ask only for the missing
user action or corrected non-secret value. Never dispatch Experiment before
configuration succeeds.

After configuration, use unrestricted `ssh-bash` `run` with short explicit
deadlines to create and inspect the selected remote project root. For a
home-relative slug, address it as `$HOME/<slug>` in remote Bash; for an explicit
absolute root, use that exact validated path. Create missing directories with an
owner-private umask. If the final directory already exists, preserve its
contents and require that it is a directory owned by the SSH user and writable
by that user. Never delete, empty, rename, or recursively change permissions on
an existing root.

Then verify:

- remote OS and architecture;
- the selected remote root's canonical path, ownership, and write permission;
- disk capacity;
- required shell, Python, `uv`, and Git availability; and
- actual GPU count/model/memory/utilization through `nvidia-smi` when required.

Do not assume hardware, CUDA, usernames, home paths, or package locations. Do
not install or upgrade anything during preflight.

## SSHFS Mount

`ssh-bash` executes remote commands; SSHFS supplies local file editing. Keep the
mount separate from the SSH tool. The tool remains general remote Bash and does
not enforce this Skill's workspace paths.

Before mounting:

- use a real mount inspection mechanism, not directory emptiness alone;
- refuse an unmounted target containing any file;
- obtain authority before creating or mounting the fixed
  `<exact-cwd>/experiment_ssh/` target;
- create that target owner-private where possible; and
- never use SSHFS `nonempty` or `allow_other`.

Before any SSHFS authentication, use platform OpenSSH tooling to obtain the
server public key without credentials, compute its OpenSSH SHA256 fingerprint,
and compare it with configured `hostFingerprint`. On Linux/macOS, write the
matching public key line to an owner-private temporary known_hosts file and pass
that file to SSHFS with `StrictHostKeyChecking=yes`. Stop before mounting on any
mismatch. Delete the temporary known_hosts file after the mount attempt.

Linux/macOS:

- require the installed `sshfs` command;
- mount only the configured remote experiment root;
- pass an absolute configured root as an absolute SSHFS source path and a
  home-relative configured root as `<slug>/`, which SSHFS resolves from the SSH
  user's home;
- for private-key authentication, pass the configured key path through
  `IdentityFile` without reading it;
- for password authentication, use SSHFS's `password_stdin` support with stdin
  redirected from the configured password file so the password never appears in
  command text or output. This is the only non-`ssh-bash` process allowed to read
  credential contents;
- if an encrypted key cannot be mounted non-interactively from the configured
  passphrase path, stop and ask the user to establish the mount manually; and
- never install SSHFS or run a package manager/sudo automatically.

Windows:

- `ssh-bash` remote execution remains available through the in-process SSH
  runtime;
- accept an existing user-managed SSHFS-Win/WinFsp mount at the configured
  exact-cwd `experiment_ssh/` path and verify it;
- do not emit POSIX commands or install a filesystem driver; and
- if no mount exists, ask the user to establish it at that fixed local path.

## Mount Identity

After mounting:

1. use `ssh-bash run` to create one owner-only random marker under the selected
   remote project root;
2. confirm the marker appears under exact-cwd `experiment_ssh/`;
3. remove it locally;
4. use `ssh-bash run` to confirm it disappeared remotely; and
5. clean up through both views on failure.

The mapping is unverified until this round trip passes. A successful SSH command
and a non-empty local directory are not sufficient.

## Handoff To Experiment

Dispatch Experiment only after `ssh-bash configure`, compute checks, and mount
identity all pass. State that exact-cwd `easyresearch.ssh` is configured and the
exact-cwd `experiment_ssh/` mount is verified. The child task must name
`experiment_ssh/` as the sole remote experiment root and include its exact
record/output/result artifact paths. Do not repeat credential paths in the child
task unless needed to diagnose a missing file. Experiment receives `ssh-bash`
and reads the single project configuration itself.

If remote execution cannot be made ready, choose local execution only when the
existing request already authorizes its resource consequences. Otherwise ask
the user or report the empirical route blocked.
