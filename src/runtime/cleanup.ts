function appendFailure(failures: unknown[], error: unknown): void {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) appendFailure(failures, nested);
    return;
  }
  if (!failures.some((failure) => Object.is(failure, error))) failures.push(error);
}

export async function runCleanupSteps(
  steps: readonly (() => void | Promise<void>)[],
  aggregateMessage: string,
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      appendFailure(failures, error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, aggregateMessage);
}
