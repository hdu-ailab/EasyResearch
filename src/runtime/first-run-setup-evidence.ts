import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export const SMOKE_SETUP_RESULT_PATH_ENV = "EASYRESEARCH_SMOKE_SETUP_RESULT_PATH";
export const SMOKE_SETUP_RUN_ID_ENV = "EASYRESEARCH_SMOKE_SETUP_RUN_ID";

export interface FirstRunSetupEvidence {
  runId: string;
  success: boolean;
}

export function writeFirstRunSetupEvidence(
  result: { success: boolean },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = env[SMOKE_SETUP_RESULT_PATH_ENV];
  const runId = env[SMOKE_SETUP_RUN_ID_ENV];
  if (path === undefined && runId === undefined) return;
  if (!path || !runId) {
    throw new Error(`${SMOKE_SETUP_RESULT_PATH_ENV} and ${SMOKE_SETUP_RUN_ID_ENV} must be set together`);
  }

  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, JSON.stringify({ runId, success: result.success }), "utf8");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readFirstRunSetupEvidence(options: {
  path: string;
  runId: string;
  read?: (path: string) => string;
}): FirstRunSetupEvidence {
  let value: unknown;
  try {
    value = JSON.parse((options.read ?? ((path) => readFileSync(path, "utf8")))(options.path));
  } catch (error) {
    throw new Error(
      `first-run setup evidence is unavailable at ${options.path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== "object" || typeof (value as { runId?: unknown }).runId !== "string"
    || typeof (value as { success?: unknown }).success !== "boolean") {
    throw new Error(`first-run setup evidence is invalid at ${options.path}`);
  }

  const evidence = value as FirstRunSetupEvidence;
  if (evidence.runId !== options.runId) {
    throw new Error(`first-run setup evidence does not match the current run ${options.runId}`);
  }
  return evidence;
}
