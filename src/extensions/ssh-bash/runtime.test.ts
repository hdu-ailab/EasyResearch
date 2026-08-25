import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSshBashRuntime,
  type SshConnectionConfig,
  type SshExecutionRequest,
  type SshExecutionResult,
} from "./runtime";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-ssh-bash-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ssh-bash runtime", () => {
  it("tests password authentication before persisting one non-secret project configuration", async () => {
    const root = tempRoot();
    const project = join(root, "project");
    const passwordFile = join(root, "password.txt");
    mkdirSync(project);
    writeFileSync(passwordFile, "secret-password\n", { mode: 0o600 });
    const requests: SshExecutionRequest[] = [];
    const runtime = createSshBashRuntime({
      execute: async (request): Promise<SshExecutionResult> => {
        requests.push(request);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    const config: SshConnectionConfig = {
      host: "gpu.example.org",
      port: 2222,
      username: "researcher",
      hostFingerprint: `SHA256:${"A".repeat(43)}`,
      authType: "password",
      credentialFile: passwordFile,
      remoteExperimentRoot: "/srv/papers/demo/experiments",
      localMountPath: join(project, "experiments"),
    };
    await runtime.configure(project, config, AbortSignal.timeout(1_000));

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ config, command: "true", password: "secret-password" });
    const settingsText = readFileSync(join(project, ".easyresearch", "settings.json"), "utf8");
    expect(settingsText).not.toContain("secret-password");
    expect(JSON.parse(settingsText)).toEqual({ easyresearch: { ssh: config } });
  });

  it("accepts a conservative home-relative remote project root", async () => {
    const root = tempRoot();
    const project = join(root, "project");
    const passwordFile = join(root, "password.txt");
    mkdirSync(project);
    writeFileSync(passwordFile, "secret-password\n", { mode: 0o600 });
    const requests: SshExecutionRequest[] = [];
    const runtime = createSshBashRuntime({
      execute: async (request): Promise<SshExecutionResult> => {
        requests.push(request);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const config: SshConnectionConfig = {
      host: "gpu.example.org",
      port: 22,
      username: "researcher",
      hostFingerprint: `SHA256:${"A".repeat(43)}`,
      authType: "password",
      credentialFile: passwordFile,
      remoteExperimentRoot: "robust-bearing-diagnosis/",
      localMountPath: join(project, "experiment_ssh"),
    };

    await runtime.configure(project, config, AbortSignal.timeout(1_000));
    await runtime.run(project, "cd /tmp && pwd", 30, AbortSignal.timeout(1_000));

    expect(requests.map(({ command }) => command)).toEqual(["true", "cd /tmp && pwd"]);
    expect(requests[1]?.config.remoteExperimentRoot).toBe("robust-bearing-diagnosis/");
    expect(JSON.parse(readFileSync(join(project, ".easyresearch", "settings.json"), "utf8")))
      .toEqual({ easyresearch: { ssh: config } });
  });

  it("does not persist a configuration whose connection test fails", async () => {
    const root = tempRoot();
    const project = join(root, "project");
    const keyFile = join(root, "id_ed25519");
    mkdirSync(project);
    writeFileSync(keyFile, "PRIVATE KEY MATERIAL", { mode: 0o600 });
    const runtime = createSshBashRuntime({
      execute: async () => ({ stdout: "", stderr: "authentication failed", exitCode: 255 }),
    });

    await expect(runtime.configure(project, {
      host: "gpu.example.org",
      port: 22,
      username: "researcher",
      hostFingerprint: `SHA256:${"A".repeat(43)}`,
      authType: "private-key",
      credentialFile: keyFile,
      remoteExperimentRoot: "/srv/papers/demo/experiments",
      localMountPath: join(project, "experiments"),
    }, AbortSignal.timeout(1_000))).rejects.toThrow(/authentication failed/i);
    expect(() => readFileSync(join(project, ".easyresearch", "settings.json"), "utf8")).toThrow();
  });

  it("loads the current project configuration and credential file for every command", async () => {
    const root = tempRoot();
    const project = join(root, "project");
    const passwordFile = join(root, "password.txt");
    mkdirSync(join(project, ".easyresearch"), { recursive: true });
    writeFileSync(passwordFile, "first-secret\n", { mode: 0o600 });
    const config: SshConnectionConfig = {
      host: "gpu.example.org",
      port: 22,
      username: "researcher",
      hostFingerprint: `SHA256:${"A".repeat(43)}`,
      authType: "password",
      credentialFile: passwordFile,
      remoteExperimentRoot: "/srv/papers/demo/experiments",
      localMountPath: join(project, "experiments"),
    };
    writeFileSync(
      join(project, ".easyresearch", "settings.json"),
      JSON.stringify({ easyresearch: { ssh: config } }),
    );
    const requests: SshExecutionRequest[] = [];
    const runtime = createSshBashRuntime({
      execute: async (request) => {
        requests.push(request);
        return { stdout: "ok\n", stderr: "", exitCode: 0 };
      },
    });

    await runtime.run(project, "nvidia-smi", 30, AbortSignal.timeout(1_000));
    writeFileSync(passwordFile, "second-secret\n", { mode: 0o600 });
    await runtime.run(project, "hostname", 30, AbortSignal.timeout(1_000));

    expect(requests.map((request) => request.password)).toEqual(["first-secret", "second-secret"]);
    expect(requests.map((request) => request.command)).toEqual(["nvidia-smi", "hostname"]);
  });

  it("rejects malformed multi-server and project-secret settings", async () => {
    const root = tempRoot();
    const project = join(root, "project");
    const passwordFile = join(root, "password.txt");
    mkdirSync(join(project, ".easyresearch"), { recursive: true });
    writeFileSync(passwordFile, "secret\n", { mode: 0o600 });
    writeFileSync(
      join(project, ".easyresearch", "settings.json"),
      JSON.stringify({
        easyresearch: {
          sshProfiles: { gpu: {} },
          ssh: {
            host: "gpu.example.org",
            port: 22,
            username: "researcher",
            hostFingerprint: `SHA256:${"A".repeat(43)}`,
            authType: "password",
            credentialFile: passwordFile,
            remoteExperimentRoot: "/srv/papers/demo/experiments",
            localMountPath: join(project, "experiments"),
          },
        },
      }),
    );
    const runtime = createSshBashRuntime({
      execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });

    await expect(runtime.test(project, AbortSignal.timeout(1_000))).rejects.toThrow(/easyresearch\.ssh/i);
  });

  it("pins one configured server for an Experiment runtime", async () => {
    const root = tempRoot();
    const project = join(root, "project");
    const passwordFile = join(root, "password.txt");
    mkdirSync(join(project, ".easyresearch"), { recursive: true });
    writeFileSync(passwordFile, "secret\n", { mode: 0o600 });
    const config: SshConnectionConfig = {
      host: "first.example.org",
      port: 22,
      username: "researcher",
      hostFingerprint: `SHA256:${"A".repeat(43)}`,
      authType: "password",
      credentialFile: passwordFile,
      remoteExperimentRoot: "/srv/papers/demo/experiments",
      localMountPath: join(project, "experiments"),
    };
    const settingsPath = join(project, ".easyresearch", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ easyresearch: { ssh: config } }));
    const runtime = createSshBashRuntime({
      pinConfiguration: true,
      execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });

    await runtime.test(project, AbortSignal.timeout(1_000));
    writeFileSync(settingsPath, JSON.stringify({
      easyresearch: { ssh: { ...config, host: "second.example.org" } },
    }));

    await expect(runtime.run(project, "hostname", 30, AbortSignal.timeout(1_000))).rejects.toThrow(/changed/i);
  });

  it.runIf(process.platform !== "win32")("rejects a physically project-local credential through an external symlink ancestor", async () => {
    const root = tempRoot();
    const project = join(root, "project");
    const secrets = join(project, "secrets");
    const externalLink = join(root, "external-link");
    mkdirSync(secrets, { recursive: true });
    writeFileSync(join(secrets, "password.txt"), "secret\n", { mode: 0o600 });
    symlinkSync(secrets, externalLink);
    const runtime = createSshBashRuntime({
      execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });

    await expect(runtime.configure(project, {
      host: "gpu.example.org",
      port: 22,
      username: "researcher",
      hostFingerprint: `SHA256:${"A".repeat(43)}`,
      authType: "password",
      credentialFile: join(externalLink, "password.txt"),
      remoteExperimentRoot: "/srv/papers/demo/experiments",
      localMountPath: join(project, "experiments"),
    }, AbortSignal.timeout(1_000))).rejects.toThrow(/outside/i);
  });

  it("rejects a malformed existing easyresearch settings namespace instead of replacing it", async () => {
    const root = tempRoot();
    const project = join(root, "project");
    const passwordFile = join(root, "password.txt");
    mkdirSync(join(project, ".easyresearch"), { recursive: true });
    writeFileSync(passwordFile, "secret\n", { mode: 0o600 });
    writeFileSync(join(project, ".easyresearch", "settings.json"), JSON.stringify({ easyresearch: "invalid" }));
    const runtime = createSshBashRuntime({
      execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });

    await expect(runtime.configure(project, {
      host: "gpu.example.org",
      port: 22,
      username: "researcher",
      hostFingerprint: `SHA256:${"A".repeat(43)}`,
      authType: "password",
      credentialFile: passwordFile,
      remoteExperimentRoot: "/srv/papers/demo/experiments",
      localMountPath: join(project, "experiments"),
    }, AbortSignal.timeout(1_000))).rejects.toThrow(/easyresearch/i);
  });
});
