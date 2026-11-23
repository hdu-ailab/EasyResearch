/** Node/Bun clamp delays above signed 32-bit to 1ms; keep long deadlines honest. */
export function scheduleShellTimeout(milliseconds: number, callback: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  let cancelled = false;
  const arm = (remaining: number) => {
    const duration = Math.min(remaining, 2_147_483_647);
    timer = setTimeout(() => {
      if (cancelled) return;
      if (remaining > duration) arm(remaining - duration);
      else callback();
    }, duration);
  };
  arm(milliseconds);
  return () => { cancelled = true; clearTimeout(timer); };
}
