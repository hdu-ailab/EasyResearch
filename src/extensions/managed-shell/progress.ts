/** Shared guidance for program output captured by local and remote managed shells. */
export const backgroundProgressDescription = [
  "For background work, configure or instrument the program to emit concise, human-readable progress to stdout/stderr as work happens: stage names, completed/total counts, and percentages only when the total is known.",
  "Prefer newline-delimited updates and flush promptly or enable unbuffered output (for example, python -u or print(..., flush=True)); these streams are captured without an interactive terminal and displayed in the Web live-output pane.",
  "For unknown totals report stages or completed counts; never invent percentages or timer-only progress.",
  "Preserve real errors and the command's exit status. Completion is reported automatically; do not poll logs or status, or launch another copy to check progress.",
].join(" ");
