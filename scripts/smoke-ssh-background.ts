import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBackgroundExecutionSmoke, runBackgroundExecutionSmoke, type BackgroundSmokeMode } from "./smoke-background-execution";
import { startSmokeSshFixture } from "./smoke-ssh-fixture";

/** Register scenario.matches/select with the native fake provider before run(). */
export async function createRemoteSshBackgroundSmoke(options: {
  runId: string; project: string; fixtureDirectory: string; agentDir: string;
}) {
  mkdirSync(options.fixtureDirectory, { recursive: true, mode: 0o700 });
  const agentName = "experiment";
  const modes: BackgroundSmokeMode[] = ["explicit", "promotion"];
  const command = (mode: BackgroundSmokeMode) => `native-ssh-${options.runId}-${mode}`;
  let scenario!: ReturnType<typeof createBackgroundExecutionSmoke>;
  const pending = new Set<Promise<void>>();
  let failure: unknown;
  const peer = await startSmokeSshFixture({ onCommand: invocation => {
    const mode = modes.find(mode => command(mode) === invocation.command);
    if (!mode) { failure = new Error("Unexpected native SSH command"); invocation.finish("", "Unexpected command", 1); return; }
    let task!: Promise<void>;
    task = (async () => {
      const response = await scenario.gate(scenario.gatePath(mode));
      assert(response?.ok, "Remote command gate failed");
      invocation.finish(scenario.marker(mode) + "\n");
    })().catch(error => { failure = error; invocation.finish("", "Remote fixture failed", 1); }).finally(() => pending.delete(task));
    pending.add(task);
  } });
  const credentialFile = join(options.fixtureDirectory, "ssh-password");
  writeFileSync(credentialFile, peer.secret, { mode: 0o600 });
  scenario = createBackgroundExecutionSmoke({
    runId: `remote-${options.runId}`, agentName, command, shellToolName: "ssh-bash",
    forbiddenText: [peer.secret],
    sshConfiguration: { ...peer.connection, authType: "password", credentialFile,
      remoteExperimentRoot: "native-smoke-project", localMountPath: join(options.project, "experiment_ssh") },
  });
  return {
    agentName, scenario,
    get failure() { return failure ?? scenario.failure; },
    redact(text: string) { return text.replaceAll(peer.secret, "[redacted SSH credential]"); },
    async run(input: { base: string; deadline: number }) {
      await runBackgroundExecutionSmoke({ ...input, project: options.project, directory: options.fixtureDirectory,
        scenario, remoteCommands: peer.commands });
      if (failure) throw failure;
      assert.equal(peer.commands.filter(command => command.command === "true").length, 2, "Compiled configure/test probes did not each execute once");
      assert(!JSON.stringify(scenario.evidence).includes(peer.secret), "SSH credential leaked to acceptance evidence");
      const records = join(options.agentDir, "background");
      if (existsSync(records)) {
        for (const path of readdirSync(records, { recursive: true }).filter(path => String(path).endsWith(".json"))) {
          assert(!readFileSync(join(records, String(path)), "utf8").includes(peer.secret), "SSH credential leaked to a durable execution/worker record");
        }
      }
    },
    async close() { scenario.release(); await Promise.all(pending); await peer.close(); },
  };
}
