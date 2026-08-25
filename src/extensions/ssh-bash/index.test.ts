import { describe, expect, it, vi } from "vitest";
import { createSshBashTool } from "./index";
import type { SshBashRuntime } from "./runtime";

function runtime(): SshBashRuntime {
  return {
    configure: vi.fn(async () => {}),
    test: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    run: vi.fn(async () => ({ stdout: "remote output\n", stderr: "", exitCode: 0 })),
  };
}

const context = { cwd: "/project" } as never;

describe("ssh-bash tool", () => {
  it("allows Research Assistant to test and persist the single SSH configuration", async () => {
    const ssh = runtime();
    const tool = createSshBashTool({ runtime: ssh, allowConfigure: true });
    const input = {
      action: "configure" as const,
      host: "gpu.example.org",
      port: 22,
      username: "researcher",
      hostFingerprint: `SHA256:${"A".repeat(43)}`,
      authType: "password" as const,
      credentialFile: "/credentials/password.txt",
      remoteExperimentRoot: "/srv/paper/experiments",
      localMountPath: "/project/experiments",
    };

    const result = await tool.execute("call-1", input, new AbortController().signal, undefined, context);

    expect(ssh.configure).toHaveBeenCalledWith("/project", {
      host: input.host,
      port: input.port,
      username: input.username,
      hostFingerprint: input.hostFingerprint,
      authType: input.authType,
      credentialFile: input.credentialFile,
      remoteExperimentRoot: input.remoteExperimentRoot,
      localMountPath: input.localMountPath,
    }, expect.anything());
    expect(result.content).toEqual([{ type: "text", text: "SSH connection configured and tested." }]);
    expect(JSON.stringify(result)).not.toContain("password.txt");
  });

  it("prevents a stage Agent from reconfiguring the connection", async () => {
    const ssh = runtime();
    const tool = createSshBashTool({ runtime: ssh, allowConfigure: false });

    await expect(tool.execute("call-2", {
      action: "configure",
      host: "gpu.example.org",
      port: 22,
      username: "researcher",
      hostFingerprint: `SHA256:${"A".repeat(43)}`,
      authType: "password",
      credentialFile: "/credentials/password.txt",
      remoteExperimentRoot: "/srv/paper/experiments",
      localMountPath: "/project/experiments",
    }, new AbortController().signal, undefined, context)).rejects.toThrow(/Research Assistant/i);
    expect(ssh.configure).not.toHaveBeenCalled();
  });

  it("runs bounded commands for Experiment without returning credential metadata", async () => {
    const ssh = runtime();
    const tool = createSshBashTool({ runtime: ssh, allowConfigure: false });

    const result = await tool.execute("call-3", {
      action: "run",
      command: "nvidia-smi",
      timeout: 60,
    }, new AbortController().signal, undefined, context);

    expect(ssh.run).toHaveBeenCalledWith("/project", "nvidia-smi", 60, expect.anything(), expect.any(Function));
    expect(result.content).toEqual([{ type: "text", text: "remote output\n" }]);
    expect(result.details).toEqual({ exitCode: 0 });
  });

  it("rejects a nonzero remote command as a tool error", async () => {
    const ssh = runtime();
    ssh.run = vi.fn(async () => ({ stdout: "", stderr: "permission denied", exitCode: 1 }));
    const tool = createSshBashTool({ runtime: ssh, allowConfigure: false });

    await expect(tool.execute("call-4", {
      action: "run",
      command: "test -w /srv/paper",
      timeout: 30,
    }, new AbortController().signal, undefined, context)).rejects.toThrow(/permission denied/i);
  });
});
