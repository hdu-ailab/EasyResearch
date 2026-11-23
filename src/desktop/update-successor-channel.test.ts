import { expect, it, vi } from "vitest";
import { createDesktopSuccessorChannel, connectDesktopSuccessorChannel } from "./update-successor-channel";
import { spawnUpdateProcess, waitForDesktopUpdateReadiness } from "./update-process";
import { desktopUpdateFailure } from "./update-protocol";

it("authenticates readiness and releases parent-life only after the custodian accepts", async () => {
  const token = "t".repeat(43), lost = vi.fn();
  const parent = await createDesktopSuccessorChannel(token);
  parent.bindChild(process.pid);
  const host = await connectDesktopSuccessorChannel({ directory: "/unused", token, workerPid: process.pid, pipe: parent.path }, lost);
  try {
    const event = { version: "0.1.24", pid: process.pid, bootId: "fresh-boot", sidecarPid: process.pid + 1 };
    let accepted = false;
    const pending = host.ready(event).then(() => { accepted = true; });
    expect(await parent.ready).toEqual(event);
    expect(accepted).toBe(false);
    await parent.accept(); await pending;
    await parent.close();
    expect(lost).not.toHaveBeenCalled();
  } finally { host.close(); await parent.close(); }
});

it("stops a connected but unaccepted host when its custodian disappears", async () => {
  const token = "t".repeat(43), lost = vi.fn();
  const parent = await createDesktopSuccessorChannel(token); parent.bindChild(process.pid);
  const host = await connectDesktopSuccessorChannel({ directory: "/unused", token, workerPid: process.pid, pipe: parent.path }, lost);
  try {
    await parent.close();
    await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce());
  } finally { host.close(); await parent.close(); }
});

it("does not treat an unacknowledged readiness report as permission to survive parent loss", async () => {
  const token = "t".repeat(43), lost = vi.fn();
  const parent = await createDesktopSuccessorChannel(token); parent.bindChild(process.pid);
  const host = await connectDesktopSuccessorChannel({ directory: "/unused", token, workerPid: process.pid, pipe: parent.path }, lost);
  try {
    const waiting = host.ready({ version: "0.1.24", pid: process.pid, bootId: "ready-but-unaccepted", sidecarPid: process.pid + 1 });
    const rejected = expect(waiting).rejects.toThrow();
    await parent.ready; await parent.close();
    await rejected;
    expect(lost).toHaveBeenCalledOnce();
  } finally { host.close(); await parent.close(); }
});

it("rejects the wrong token or child identity before admitting a readiness message", async () => {
  for (const wrong of ["token", "pid"]) {
    const token = "t".repeat(43), parent = await createDesktopSuccessorChannel(token);
    parent.bindChild(wrong === "pid" ? process.pid + 1 : process.pid);
    try {
      await expect(connectDesktopSuccessorChannel({ directory: "/unused", token: wrong === "token" ? "x".repeat(43) : token, workerPid: process.pid, pipe: parent.path }, () => {})).rejects.toThrow();
    } finally { await parent.close(); }
  }
});

it("retains the natural child exit when authenticated channel closure arrives first", async () => {
  const token = "t".repeat(43), parent = await createDesktopSuccessorChannel(token);
  const script = `const socket=require('node:net').createConnection(${JSON.stringify(parent.path)});
socket.on('error',()=>{});socket.on('connect',()=>socket.write(JSON.stringify({type:'attach',token:${JSON.stringify(token)},pid:process.pid})+'\\n'));
socket.once('data',()=>socket.end());
socket.once('close',()=>setTimeout(()=>process.stderr.write('fatal: child startup failed\\n',()=>process.exit(17)),50));`;
  const child = spawnUpdateProcess(process.execPath, ["-e", script]); parent.bindChild(child.child.pid!);
  try {
    const error = await waitForDesktopUpdateReadiness(parent.ready, child, 5000).catch(error => error);
    expect(desktopUpdateFailure("recovery-launch", error)).toMatchObject({ code: "UPDATE_PROCESS_EXIT", childExitCode: 17, stderr: "fatal: child startup failed\n" });
  } finally { await parent.close(); await child.stop(); }
});
