/** Native OS observations/cleanup for the private Windows updater gate. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { windowsInstallerRegistryId } from "../src/desktop/update-worker";
import { powershell } from "./smoke-desktop-update-fixture";

export interface WindowsFixtureProcess { pid: number; parentPid: number; start: string; executable: string; worker: boolean; installer: boolean; job: boolean; requestedFrench?: boolean }
export async function fixtureWindowsProcesses(root: string, previouslyOwned: readonly WindowsFixtureProcess[] = []): Promise<WindowsFixtureProcess[]> {
  const result = await powershell(`
    $root=[IO.Path]::GetFullPath($env:ER_FIXTURE_ROOT).TrimEnd('\\')+'\\';
    $all=@(Get-CimInstance Win32_Process); $owned=@{}; $known=@(ConvertFrom-Json $env:ER_FIXTURE_KNOWN_PROCESSES);
    foreach($p in $all){
      if(($p.ExecutablePath -and $p.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) -or
        ($p.CommandLine -and $p.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0)){$owned[[int]$p.ProcessId]=$true}
      foreach($k in $known){if([int]$p.ProcessId -eq $k.pid -and $p.CreationDate.ToUniversalTime().ToString('o') -ceq $k.start){$owned[[int]$p.ProcessId]=$true}}
    }
    do {$added=$false; foreach($p in $all){if($owned.ContainsKey([int]$p.ParentProcessId) -and !$owned.ContainsKey([int]$p.ProcessId)){$owned[[int]$p.ProcessId]=$true;$added=$true}}}while($added)
    $rows=@(foreach($p in $all){if($owned.ContainsKey([int]$p.ProcessId)){
      @{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;start=$p.CreationDate.ToUniversalTime().ToString('o');executable=[string]$p.ExecutablePath;
        worker=([string]$p.CommandLine).Contains('--desktop-update-worker');installer=([string]$p.Name -like '*EasyResearch-*.exe');job=([string]$p.Name -match '^(powershell|pwsh).exe$');requestedFrench=([string]$p.CommandLine -match '(?:^|\\s)--lang=fr(?:\\s|$)')}
    }}); ConvertTo-Json -InputObject $rows -Compress
  `, { ...process.env, ER_FIXTURE_ROOT: root, ER_FIXTURE_KNOWN_PROCESSES: JSON.stringify(previouslyOwned) });
  return JSON.parse(result.trim() || "[]") as WindowsFixtureProcess[];
}

export async function stopFixtureWindowsProcesses(root: string, previouslyOwned: readonly WindowsFixtureProcess[] = []): Promise<void> {
  // Every PID is rechecked against creation identity immediately before signalling.
  // The freshly created private root is never reused by another installation.
  for (let attempt = 0; attempt < 5; attempt++) {
    const processes = await fixtureWindowsProcesses(root, previouslyOwned); if (!processes.length) return;
    await powershell(`
      $rows=@(ConvertFrom-Json $env:ER_FIXTURE_PROCESSES);
      foreach($row in $rows){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$row.pid); if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -ceq $row.start){Stop-Process -Id $row.pid -Force -ErrorAction SilentlyContinue}}
    `, { ...process.env, ER_FIXTURE_PROCESSES: JSON.stringify(processes) });
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal((await fixtureWindowsProcesses(root, previouslyOwned)).length, 0, "Owned Windows fixture processes survived cleanup");
}

export interface InstallationRegistryEntry { hive: string; view: string; key: string; location: string; version: string }
export async function windowsInstallationRegistry(): Promise<InstallationRegistryEntry[]> {
  const result = await powershell(`
    $keys=@(('Software\\'+$env:ER_FIXTURE_APP_ID),('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$env:ER_FIXTURE_APP_ID));
    $rows=@(foreach($hive in @('CurrentUser','LocalMachine')){foreach($view in @('Registry64','Registry32')){
      $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive,[Microsoft.Win32.RegistryView]::$view);
      try{foreach($key in $keys){$item=$base.OpenSubKey($key);if($null -ne $item){try{@{hive=$hive;view=$view;key=$key;location=[string]$item.GetValue('InstallLocation');version=[string]$item.GetValue('DisplayVersion')}}finally{$item.Dispose()}}}}finally{$base.Dispose()}
    }});ConvertTo-Json -InputObject $rows -Compress
  `, { ...process.env, ER_FIXTURE_APP_ID: windowsInstallerRegistryId() });
  return JSON.parse(result.trim() || "[]") as InstallationRegistryEntry[];
}

export async function assertFixtureInstallation(directory: string, version?: string): Promise<void> {
  const rows = await windowsInstallationRegistry();
  assert(rows.length > 0, "NSIS did not publish the real installation registry");
  assert(rows.every(row => row.hive === "CurrentUser" && row.location && win32.resolve(row.location).toLowerCase() === win32.resolve(directory).toLowerCase()), "NSIS registry points outside the owned current-user installation");
  if (version) assert(rows.some(row => row.version === version), "Installed NSIS version does not match its registry");
}

// Read-only native accessibility, plus two explicitly requested OS actions. No
// injected JavaScript, product IPC hook, debugger propagation or unsigned patch.
const NATIVE_WINDOWS = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Accessibility;
public static class ErUpdateWindows {
  public delegate bool EnumCallback(IntPtr hwnd, IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, EnumCallback callback, IntPtr state);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetMenu(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint objectId, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object result);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible parent, int start, int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex=2)] object[] children, out int obtained);
  public static IntPtr[] Windows(int pid) { var list=new List<IntPtr>(); EnumWindows((h,s)=>{uint p; GetWindowThreadProcessId(h,out p); if(p==pid)list.Add(h);return true;},IntPtr.Zero); return list.ToArray(); }
  public static string Text(IntPtr hwnd) { var text=new StringBuilder(8192);GetWindowText(hwnd,text,text.Capacity);return text.ToString(); }
  public static string[] Texts(int pid) { var texts=new HashSet<string>();foreach(var window in Windows(pid)){if(!IsWindowVisible(window))continue;texts.Add(Text(window));EnumChildWindows(window,(h,s)=>{texts.Add(Text(h));return true;},IntPtr.Zero);}return new List<string>(texts).ToArray(); }
  public static bool HasMenu(int pid) { foreach(var window in Windows(pid)){if(GetMenu(window)!=IntPtr.Zero)return true;}return false; }
  static void Values(IAccessible accessible, HashSet<string> values, ref int budget, int depth, bool names) {
    if(budget--<=0 || depth>40)return;
    try{string value=names ? accessible.get_accName(0) : accessible.get_accValue(0);if(value!=null && value.Length<8192 && (names || value.StartsWith("http://127.0.0.1:")))values.Add(value);}catch{}
    try{int count=Math.Min(accessible.accChildCount,Math.Max(0,budget));if(count<=0)return;var children=new object[count];int got;
      if(AccessibleChildren(accessible,0,count,children,out got)<0)return;
      for(int i=0;i<got;i++){var child=children[i] as IAccessible;if(child!=null)Values(child,values,ref budget,depth+1,names);else if(names && children[i] is int){try{var name=accessible.get_accName(children[i]);if(name!=null && name.Length<8192)values.Add(name);}catch{}}}
    }catch{}
  }
  public static string[] DocumentValues(int pid, bool names) { var values=new HashSet<string>();int budget=4096;var handles=new List<IntPtr>();foreach(var w in Windows(pid)){handles.Add(w);EnumChildWindows(w,(h,s)=>{handles.Add(h);return true;},IntPtr.Zero);}foreach(var h in handles){object value;var iid=new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");try{if(AccessibleObjectFromWindow(h,0xFFFFFFFC,ref iid,out value)==0){var a=value as IAccessible;if(a!=null)Values(a,values,ref budget,0,names);}}catch{}}return new List<string>(values).ToArray(); }
  public static bool CloseRecovery(int pid) { foreach(var window in Windows(pid)){if(Text(window)!="EasyResearch update")continue;bool release=false;IntPtr close=IntPtr.Zero;EnumChildWindows(window,(h,s)=>{var text=Text(h).Replace("&","");if(text=="Open latest Release")release=true;if(text=="Close")close=h;return true;},IntPtr.Zero);if(release && close!=IntPtr.Zero){IntPtr result;SendMessageTimeout(close,0xF5,IntPtr.Zero,IntPtr.Zero,2,5000,out result);return true;}}return false; }
  public static void RequestExit(int pid) { foreach(var window in Windows(pid)){IntPtr result;SendMessageTimeout(window,0x11,IntPtr.Zero,IntPtr.Zero,2,5000,out result);} }
}
`;

async function nativeWindows(pid: number, expression: string): Promise<string> {
  assert(Number.isSafeInteger(pid) && pid > 0, "Invalid owned host PID");
  return powershell(`Add-Type -AssemblyName Accessibility; Add-Type -TypeDefinition $env:ER_FIXTURE_WINDOW_SOURCE -ReferencedAssemblies @([Accessibility.IAccessible].Assembly.Location,'System.dll','System.Core.dll'); ${expression}`,
    { ...process.env, ER_FIXTURE_WINDOW_SOURCE: NATIVE_WINDOWS, ER_FIXTURE_HOST_PID: String(pid) });
}

export async function installedWindowEvidence(pid: number): Promise<{ urls: string[]; names: string[]; texts: string[] }> {
  const text = await nativeWindows(pid, "@{urls=@([ErUpdateWindows]::DocumentValues([int]$env:ER_FIXTURE_HOST_PID,$false));names=@([ErUpdateWindows]::DocumentValues([int]$env:ER_FIXTURE_HOST_PID,$true));texts=@([ErUpdateWindows]::Texts([int]$env:ER_FIXTURE_HOST_PID))}|ConvertTo-Json -Compress");
  return JSON.parse(text.trim());
}
export async function closeRecoveryReleaseDialog(pid: number): Promise<boolean> {
  return (await nativeWindows(pid, "[Console]::Write([ErUpdateWindows]::CloseRecovery([int]$env:ER_FIXTURE_HOST_PID))")).trim() === "True";
}
export async function requestInstalledHostExit(pid: number): Promise<void> {
  await nativeWindows(pid, "[ErUpdateWindows]::RequestExit([int]$env:ER_FIXTURE_HOST_PID)");
}
export async function installedHostHasNativeMenu(pid: number): Promise<boolean> {
  return (await nativeWindows(pid, "[Console]::Write([ErUpdateWindows]::HasMenu([int]$env:ER_FIXTURE_HOST_PID))")).trim() === "True";
}

export function readBoundedFixtureJson<T>(path: string): T | undefined {
  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  assert(bytes.length <= 64 * 1024, "Oversized fixture receipt");
  try { return JSON.parse(bytes.toString("utf8")) as T; }
  catch { return; } // atomic publication may not yet have completed
}

export interface FixtureServerRecord { schema: 1; owner: "desktop"; host: "127.0.0.1"; pid: number; port: number; token: string; runtimeId: string }
export function readFixtureServer(agentDir: string): FixtureServerRecord | undefined {
  const record = readBoundedFixtureJson<FixtureServerRecord>(join(agentDir, "server.pid"));
  if (!record) return;
  assert(record.schema === 1 && record.owner === "desktop" && record.host === "127.0.0.1"
    && Number.isSafeInteger(record.pid) && record.pid > 0 && Number.isSafeInteger(record.port) && record.port > 0
    && typeof record.token === "string" && record.token.length >= 32 && typeof record.runtimeId === "string" && record.runtimeId.length > 0, "Invalid private Desktop owner record");
  return record;
}
