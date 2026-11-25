/** Native OS observations/cleanup for the private Windows updater gate. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { windowsInstallerRegistryId } from "../src/desktop/update-worker";
import { LATEST_RELEASE_PAGE } from "../src/runtime/update-contract";
import { assertFixtureChild, assertHostedWindowsFixture, fixtureDiagnosticError, powershell, runFixtureCommand, withFixtureRoamingBinding } from "./smoke-desktop-update-fixture";

export interface WindowsFixtureProcess { pid: number; parentPid: number; start: string; executable: string; worker: boolean; installer: boolean; job: boolean; requestedFrench?: boolean }
export function retainFixtureProcessObservation(previous: WindowsFixtureProcess | undefined, current: WindowsFixtureProcess): WindowsFixtureProcess {
  if (!previous || previous.pid !== current.pid || previous.start !== current.start) return current;
  assert(previous.parentPid === current.parentPid, "Conflicting retained process parent identity");
  assert(!previous.executable || !current.executable || previous.executable.toLowerCase() === current.executable.toLowerCase(), "Conflicting retained process executable identity");
  return { ...current, executable: current.executable || previous.executable,
    worker: previous.worker || current.worker, installer: previous.installer || current.installer,
    job: previous.job || current.job, requestedFrench: previous.requestedFrench || current.requestedFrench };
}
export function parseFixtureWindowsProcesses(text: string): WindowsFixtureProcess[] {
  assert(Buffer.byteLength(text, "utf8") <= 2 * 1024 * 1024, "Windows process observations exceed their bound");
  const rows: unknown = JSON.parse(text);
  assert(Array.isArray(rows) && rows.length <= 4096, "Expected a bounded flat Windows process array");
  const seen = new Set<number>();
  return rows.map(value => {
    assert(value && typeof value === "object" && !Array.isArray(value), "Invalid Windows process observation");
    const row = value as Record<string, unknown>;
    assert(Number.isSafeInteger(row.pid) && (row.pid as number) > 0 && (row.pid as number) <= 0x7fffffff
      && Number.isSafeInteger(row.parentPid) && (row.parentPid as number) >= 0 && (row.parentPid as number) <= 0x7fffffff
      && typeof row.start === "string" && row.start.trim().length > 0 && row.start.length <= 128 && !/[\r\n\0]/u.test(row.start)
      && typeof row.executable === "string" && row.executable.length <= 32767 && !/[\r\n\0]/u.test(row.executable)
      && typeof row.worker === "boolean" && typeof row.installer === "boolean" && typeof row.job === "boolean"
      && (row.requestedFrench === undefined || typeof row.requestedFrench === "boolean"), "Invalid Windows process identity or flags");
    assert(!seen.has(row.pid as number), "Duplicate Windows process identity"); seen.add(row.pid as number);
    return { pid: row.pid as number, parentPid: row.parentPid as number, start: row.start, executable: row.executable,
      worker: row.worker, installer: row.installer, job: row.job,
      ...(row.requestedFrench === undefined ? {} : { requestedFrench: row.requestedFrench as boolean }) };
  });
}
export async function fixtureWindowsProcesses(root: string, previouslyOwned: readonly WindowsFixtureProcess[] = []): Promise<WindowsFixtureProcess[]> {
  const known = parseFixtureWindowsProcesses(JSON.stringify(previouslyOwned));
  const result = await powershell(`
    $root=[IO.Path]::GetFullPath($env:ER_FIXTURE_ROOT).TrimEnd('\\')+'\\';
    $all=@(Get-CimInstance Win32_Process); $owned=@{}; $known=ConvertFrom-Json $env:ER_FIXTURE_KNOWN_PROCESSES;
    foreach($k in $known){
      $knownPid=0;
      if($null -eq $k -or $k -is [array] -or $k.pid -is [array] -or ![int]::TryParse([string]$k.pid,[ref]$knownPid) -or $knownPid -le 0 -or $k.start -isnot [string] -or [string]::IsNullOrWhiteSpace($k.start)){throw 'Invalid retained fixture process identity'}
    }
    foreach($p in $all){
      if(($p.ExecutablePath -and $p.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) -or
        ($p.CommandLine -and $p.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0)){$owned[[int]$p.ProcessId]=$true}
      foreach($k in $known){if([int]$p.ProcessId -eq [int]$k.pid -and $p.CreationDate.ToUniversalTime().ToString('o') -ceq $k.start){$owned[[int]$p.ProcessId]=$true}}
    }
    do {$added=$false; foreach($p in $all){if($owned.ContainsKey([int]$p.ParentProcessId) -and !$owned.ContainsKey([int]$p.ProcessId)){$owned[[int]$p.ProcessId]=$true;$added=$true}}}while($added)
    $rows=@(foreach($p in $all){if($owned.ContainsKey([int]$p.ProcessId)){
      @{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;start=$p.CreationDate.ToUniversalTime().ToString('o');executable=[string]$p.ExecutablePath;
        worker=([string]$p.CommandLine).Contains('--desktop-update-worker');installer=([string]$p.Name -like '*EasyResearch-*.exe');job=([string]$p.Name -match '^(powershell|pwsh).exe$');requestedFrench=([string]$p.CommandLine -match '(?:^|\\s)--lang=fr(?:\\s|$)')}
    }}); ConvertTo-Json -InputObject $rows -Compress
  `, { ...process.env, ER_FIXTURE_ROOT: root, ER_FIXTURE_KNOWN_PROCESSES: JSON.stringify(known) });
  const rows = parseFixtureWindowsProcesses(result);
  assert(rows.every(row => row.pid !== process.pid && row.pid !== process.ppid), "Fixture process observation included its caller or parent");
  return rows;
}

export async function stopFixtureWindowsProcesses(root: string, previouslyOwned: readonly WindowsFixtureProcess[] = []): Promise<void> {
  // Every PID is rechecked against creation identity immediately before signalling.
  // The freshly created private root is never reused by another installation.
  const known = new Map(parseFixtureWindowsProcesses(JSON.stringify(previouslyOwned)).map(row => [row.pid, row]));
  for (let attempt = 0; attempt < 5; attempt++) {
    const processes = await fixtureWindowsProcesses(root, [...known.values()]); if (!processes.length) return;
    for (const row of processes) known.set(row.pid, retainFixtureProcessObservation(known.get(row.pid), row));
    await powershell(`
      $rows=ConvertFrom-Json $env:ER_FIXTURE_PROCESSES;
      foreach($row in $rows){
        $targetPid=0;
        if($null -eq $row -or $row -is [array] -or $row.pid -is [array] -or ![int]::TryParse([string]$row.pid,[ref]$targetPid) -or $targetPid -le 0 -or $row.start -isnot [string] -or [string]::IsNullOrWhiteSpace($row.start)){throw 'Invalid fixture process cleanup identity'}
        if($targetPid -eq $PID -or $targetPid -eq [int]$env:ER_FIXTURE_CALLER_PID -or $targetPid -eq [int]$env:ER_FIXTURE_PARENT_PID){throw 'Refusing to stop a fixture observer or its parent'}
        $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[string]$targetPid);
        if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -ceq $row.start){Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue}
      }
    `, { ...process.env, ER_FIXTURE_PROCESSES: JSON.stringify(processes), ER_FIXTURE_CALLER_PID: String(process.pid), ER_FIXTURE_PARENT_PID: String(process.ppid) });
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal((await fixtureWindowsProcesses(root, [...known.values()])).length, 0, "Owned Windows fixture processes survived cleanup");
}

export interface InstallationRegistryEntry { hive: string; view: string; key: string; location: string; version: string; uninstall: string }
export async function windowsInstallationRegistry(): Promise<InstallationRegistryEntry[]> {
  const result = await powershell(`
    $keys=@(('Software\\'+$env:ER_FIXTURE_APP_ID),('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$env:ER_FIXTURE_APP_ID));
    $rows=@(foreach($hive in @('CurrentUser','LocalMachine')){foreach($view in @('Registry64','Registry32')){
      $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive,[Microsoft.Win32.RegistryView]::$view);
      try{foreach($key in $keys){$item=$base.OpenSubKey($key);if($null -ne $item){try{@{hive=$hive;view=$view;key=$key;location=[string]$item.GetValue('InstallLocation');version=[string]$item.GetValue('DisplayVersion');uninstall=[string]$item.GetValue('UninstallString')}}finally{$item.Dispose()}}}}finally{$base.Dispose()}
    }});ConvertTo-Json -InputObject $rows -Compress
  `, { ...process.env, ER_FIXTURE_APP_ID: windowsInstallerRegistryId() });
  return JSON.parse(result.trim() || "[]") as InstallationRegistryEntry[];
}

export async function assertFixtureInstallation(directory: string, version?: string): Promise<void> {
  const rows = await windowsInstallationRegistry();
  assertWindowsFixtureInstallation(rows, directory, version);
}

export function assertWindowsFixtureInstallation(rows: readonly InstallationRegistryEntry[], directory: string, version?: string): void {
  assert(rows.length > 0, "NSIS did not publish the real installation registry");
  const id = windowsInstallerRegistryId();
  const installationKey = `Software\\${id}`.toLowerCase();
  const uninstallKey = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${id}`.toLowerCase();
  const samePath = (a: string, b: string) => win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();
  assert(rows.every(row => row.hive === "CurrentUser" && ["Registry32", "Registry64"].includes(row.view)
    && [installationKey, uninstallKey].includes(row.key.toLowerCase())), "Unexpected NSIS registry owner or key");
  for (const view of new Set(rows.map(row => row.view))) {
    const installation = rows.filter(row => row.view === view && row.key.toLowerCase() === installationKey);
    const uninstall = rows.filter(row => row.view === view && row.key.toLowerCase() === uninstallKey);
    assert(installation.length === 1 && uninstall.length === 1, "Incomplete or duplicate NSIS registry pair");
    assert(installation[0]!.location && samePath(installation[0]!.location, directory), "NSIS registry points outside the owned current-user installation");
    const entry = uninstall[0]!;
    const command = /^"([^"]+)"\s+\/currentuser$/iu.exec(entry.uninstall);
    assert(command && samePath(command[1]!, win32.join(directory, "Uninstall EasyResearch.exe")), "NSIS uninstall command is outside the owned current-user installation");
    assert(!entry.location || samePath(entry.location, directory), "Conflicting NSIS uninstall location");
    assert(entry.version && (!version || entry.version === version), "Installed NSIS version does not match its registry");
  }
}

// Read-only native accessibility, plus owned window/profile actions. No
// injected JavaScript, product IPC hook, debugger propagation or unsigned patch.
// Source checks: Chromium 148.0.7778.218 ui/accessibility/platform/
// ax_platform_node_win.cc (get_accName, get_accDefaultAction, GetValueAttributeAsBstr),
// content/browser/accessibility/browser_accessibility_state_impl.cc, and Blink's
// modules/accessibility/blink_ax_tree_source.cc::GetTreeData (full document URL).
// Integer children follow Microsoft's IAccessible::get_accChild contract:
// https://learn.microsoft.com/windows/win32/api/oleacc/nf-oleacc-iaccessible-get_accchild
const NATIVE_WINDOWS = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Accessibility;
public static class ErUpdateWindows {
  static Guid roaming = new Guid("3EB685DB-65F9-4CF6-A03A-E3EF65729F3D");
  [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern int SHSetKnownFolderPath(ref Guid id, uint flags, IntPtr token, string path);
  public static string RoamingPath() { IntPtr path; Marshal.ThrowExceptionForHR(SHGetKnownFolderPath(ref roaming,0,IntPtr.Zero,out path)); try{return Marshal.PtrToStringUni(path);}finally{Marshal.FreeCoTaskMem(path);} }
  public static void SetRoamingPath(string path) { Marshal.ThrowExceptionForHR(SHSetKnownFolderPath(ref roaming,0,IntPtr.Zero,path)); }
  public delegate bool EnumCallback(IntPtr hwnd, IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, EnumCallback callback, IntPtr state);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetMenu(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint objectId, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object result);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible parent, int start, int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex=2)] object[] children, out int obtained);
  public static IntPtr[] Windows(int pid) { var list=new List<IntPtr>(); EnumWindows((h,s)=>{uint p; GetWindowThreadProcessId(h,out p); if(p==pid)list.Add(h);return list.Count<=512;},IntPtr.Zero); return list.ToArray(); }
  public static string Text(IntPtr hwnd) { var text=new StringBuilder(8192);GetWindowText(hwnd,text,text.Capacity);return text.ToString(); }
  public static string[] Texts(int pid) { var texts=new HashSet<string>();foreach(var window in Windows(pid)){if(!IsWindowVisible(window))continue;texts.Add(Text(window));EnumChildWindows(window,(h,s)=>{texts.Add(Text(h));return true;},IntPtr.Zero);}return new List<string>(texts).ToArray(); }
  public static bool HasMenu(int pid) { foreach(var window in Windows(pid)){if(GetMenu(window)!=IntPtr.Zero)return true;}return false; }
  public class Scan {
    public int handles, accessibleRoots, rootFailures, visited, integerChildren, resolvedIntegerChildren, propertyErrors, activationReads;
    public bool budgetLimited, depthLimited, valueLimited;
  }
  public class WindowSample { public long hwnd; public string className; public bool visible; public int result; }
  public class WindowEvidence {
    public string[] urls, names, texts;
    public Scan scan=new Scan(); public List<WindowSample> windows=new List<WindowSample>();
  }
  class Values {
    public HashSet<string> urls=new HashSet<string>(), names=new HashSet<string>(), texts=new HashSet<string>();
    public int bytes; public Scan scan;
    public void Add(HashSet<string> target,string value) {
      if(String.IsNullOrEmpty(value) || target.Contains(value))return;
      if(value.Length>=8192){scan.valueLimited=true;return;}
      int size=Encoding.UTF8.GetByteCount(value)+16;
      if(bytes+size>262144){scan.valueLimited=true;return;}
      bytes+=size;target.Add(value);
    }
  }
  static void Properties(IAccessible accessible,object child,Values values) {
    try{values.Add(values.names,accessible.get_accName(child));}catch{values.scan.propertyErrors++;}
    // Chromium 148 ax_platform_node_win.cc: names enable only minimal APIs;
    // reading DefaultAction calls OnExtendedPropertiesUsed for web content.
    // This is an ordinary read, never accDoDefaultAction or a product hook.
    try{accessible.get_accDefaultAction(child);values.scan.activationReads++;}catch{values.scan.propertyErrors++;}
    try{string value=accessible.get_accValue(child);if(value!=null && value.StartsWith("http://127.0.0.1:",StringComparison.Ordinal))values.Add(values.urls,value);}catch{values.scan.propertyErrors++;}
  }
  static void Walk(IAccessible accessible,Values values,ref int budget,int depth,Action<IAccessible,object,int> inspect=null) {
    if(budget<=0){values.scan.budgetLimited=true;return;}
    if(depth>40){values.scan.depthLimited=true;return;}
    budget--;values.scan.visited++;Properties(accessible,0,values);if(inspect!=null)inspect(accessible,0,depth);
    try{
      int available=accessible.accChildCount,count=Math.Min(available,Math.Max(0,budget));
      if(count<available)values.scan.budgetLimited=true;
      if(count<=0)return;
      var children=new object[count];int got;
      if(AccessibleChildren(accessible,0,count,children,out got)<0){values.scan.propertyErrors++;return;}
      for(int i=0;i<Math.Min(got,count);i++){
        if(budget<=0){values.scan.budgetLimited=true;break;}
        var child=children[i] as IAccessible;
        if(child!=null){Walk(child,values,ref budget,depth+1,inspect);continue;}
        if(!(children[i] is int))continue;
        values.scan.integerChildren++;
        // MSAA VT_I4 can identify a full accessible object, not only a leaf.
        // get_accChild returns null for a simple child: read both properties on
        // the parent with that child ID, rather than dropping values/subtrees.
        try{if((int)children[i]!=0)child=accessible.get_accChild(children[i]) as IAccessible;}catch{values.scan.propertyErrors++;}
        if(child!=null && !Object.ReferenceEquals(child,accessible)){values.scan.resolvedIntegerChildren++;Walk(child,values,ref budget,depth+1,inspect);}
        else{
          if(depth>=40){values.scan.depthLimited=true;continue;}
          budget--;values.scan.visited++;Properties(accessible,children[i],values);if(inspect!=null)inspect(accessible,children[i],depth+1);
        }
      }
    }catch{values.scan.propertyErrors++;}
  }
  public static WindowEvidence Evidence(int pid) {
    var result=new WindowEvidence();var values=new Values();values.scan=result.scan;
    var handles=new HashSet<IntPtr>();
    foreach(var window in Windows(pid)){
      handles.Add(window);
      EnumChildWindows(window,(h,s)=>{uint p;GetWindowThreadProcessId(h,out p);if(p==pid && handles.Count<512)handles.Add(h);return handles.Count<512;},IntPtr.Zero);
      if(handles.Count>=512)break;
    }
    int budget=4096;result.scan.handles=handles.Count;
    foreach(var h in handles){
      uint p;GetWindowThreadProcessId(h,out p);if(p!=pid)continue;
      var sample=new WindowSample();sample.hwnd=h.ToInt64();sample.visible=IsWindowVisible(h);
      var className=new StringBuilder(256);GetClassName(h,className,className.Capacity);sample.className=className.ToString();
      if(sample.visible)values.Add(values.texts,Text(h));
      object value;var iid=new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
      try{sample.result=AccessibleObjectFromWindow(h,0xFFFFFFFC,ref iid,out value);var accessible=value as IAccessible;
        if(sample.result==0 && accessible!=null){result.scan.accessibleRoots++;Walk(accessible,values,ref budget,0);}
        else result.scan.rootFailures++;
      }catch(Exception error){sample.result=Marshal.GetHRForException(error);result.scan.rootFailures++;}
      if(result.windows.Count<64)result.windows.Add(sample);
    }
    result.urls=new List<string>(values.urls).ToArray();result.names=new List<string>(values.names).ToArray();result.texts=new List<string>(values.texts).ToArray();
    return result;
  }
  public class RecoveryDialog {
    public string documentUrl,title,notice,releaseUrl;
    public int closeButtons,enabledCloseButtons;
    internal IAccessible close;internal object child;
  }
  public class RecoveryEvidence {
    public int documents;public bool invoked;
    public List<RecoveryDialog> dialogs=new List<RecoveryDialog>();public Scan scan;
  }
  class RecoveryScan {
    public RecoveryEvidence result=new RecoveryEvidence();
    string url,title,notice,release;
    string[] documents=new string[41];RecoveryDialog[] dialogs=new RecoveryDialog[41];bool[] hidden=new bool[41];
    public RecoveryScan(string url,string title,string notice,string release,Scan scan) {
      this.url=url;this.title=title;this.notice=notice;this.release=release;result.scan=scan;
    }
    public static bool EnabledClose(IAccessible accessible,object child) {
      return Convert.ToInt32(accessible.get_accRole(child))==43 && accessible.get_accName(child)=="Close"
        && (Convert.ToInt32(accessible.get_accState(child)) & (1|0x8000|0x10000))==0
        && !String.IsNullOrEmpty(accessible.get_accDefaultAction(child));
    }
    public void Visit(IAccessible accessible,object child,int depth) {
      documents[depth]=depth==0?null:documents[depth-1];dialogs[depth]=depth==0?null:dialogs[depth-1];
      hidden[depth]=depth!=0 && hidden[depth-1];
      try {
        int role=Convert.ToInt32(accessible.get_accRole(child)),state=Convert.ToInt32(accessible.get_accState(child));
        hidden[depth]=hidden[depth] || (state & 0x8000)!=0;
        if(hidden[depth])return;
        string name=accessible.get_accName(child),value=null;
        if(role==15 || role==30)value=accessible.get_accValue(child);
        if((name!=null && name.Length>=8192) || (value!=null && value.Length>=8192)){result.scan.valueLimited=true;return;}
        if(role==15) {
          documents[depth]=value;dialogs[depth]=null;
          if(value==url)result.documents++;
        }
        if(role==18) {
          dialogs[depth]=null;
          if(documents[depth]==url && name==title) {
            if(result.dialogs.Count>=16){result.scan.budgetLimited=true;return;}
            var dialog=new RecoveryDialog();dialog.documentUrl=documents[depth];dialog.title=name;
            result.dialogs.Add(dialog);dialogs[depth]=dialog;
          }
        }
        var current=dialogs[depth];
        if(current==null || documents[depth]!=url)return;
        if(name==notice)current.notice=name;
        if(role==30 && name=="Open latest Release" && value==release)current.releaseUrl=value;
        if(role==43 && name=="Close") {
          current.closeButtons++;
          if(EnabledClose(accessible,child)){current.enabledCloseButtons++;current.close=accessible;current.child=child;}
        }
      }catch{result.scan.propertyErrors++;}
    }
    public bool Ready() {
      if(result.documents!=1 || result.dialogs.Count!=1 || result.scan.rootFailures!=0 || result.scan.propertyErrors!=0
        || result.scan.budgetLimited || result.scan.depthLimited || result.scan.valueLimited)return false;
      var dialog=result.dialogs[0];
      return dialog.documentUrl==url && dialog.title==title && dialog.notice==notice && dialog.releaseUrl==release
        && dialog.closeButtons==1 && dialog.enabledCloseButtons==1;
    }
  }
  public static RecoveryEvidence Recovery(int pid,string url,string title,string notice,string release,bool perform,Action confirmOwner) {
    var values=new Values();values.scan=new Scan();var scan=new RecoveryScan(url,title,notice,release,values.scan);
    int budget=4096;
    foreach(var window in Windows(pid)) {
      if(++values.scan.handles>512){values.scan.budgetLimited=true;break;}
      uint owner;GetWindowThreadProcessId(window,out owner);
      var className=new StringBuilder(256);GetClassName(window,className,className.Capacity);
      // Scan the main top-level client once. Rewalking child HWNDs would count
      // the same document/dialog repeatedly and could authorize an ambiguous Close.
      if(owner!=pid || !IsWindowVisible(window) || className.ToString()!="Chrome_WidgetWin_1")continue;
      object value;var iid=new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
      try{
        if(AccessibleObjectFromWindow(window,0xFFFFFFFC,ref iid,out value)!=0 || !(value is IAccessible)){values.scan.rootFailures++;continue;}
        values.scan.accessibleRoots++;Walk((IAccessible)value,values,ref budget,0,scan.Visit);
      }catch{values.scan.rootFailures++;}
    }
    if(perform && scan.Ready()) {
      confirmOwner();var dialog=scan.result.dialogs[0];
      if(RecoveryScan.EnabledClose(dialog.close,dialog.child)){dialog.close.accDoDefaultAction(dialog.child);scan.result.invoked=true;}
    }
    return scan.result;
  }
  public static void RequestExit(int pid) { foreach(var window in Windows(pid)){IntPtr result;SendMessageTimeout(window,0x11,IntPtr.Zero,IntPtr.Zero,2,5000,out result);} }
}
`;

let nativeAssembly: Promise<string> | undefined;
function nativeFixtureAssembly(): Promise<string> {
  assertHostedWindowsFixture();
  nativeAssembly ??= (async () => {
    const directory = mkdtempSync(join(tmpdir(), "easyresearch-window-fixture-"));
    try {
      const reference = (await powershell("Add-Type -AssemblyName Accessibility; [Console]::Write([Accessibility.IAccessible].Assembly.Location)", process.env, 30_000, "Accessibility reference lookup")).trim();
      assert(win32.isAbsolute(reference) && existsSync(reference), "Native Accessibility reference is unavailable");
      const source = join(directory, "windows.cs"), output = join(directory, "windows.dll");
      writeFileSync(source, NATIVE_WINDOWS);
      await runFixtureCommand(win32.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
        ["/nologo", "/noconfig", "/target:library", "/optimize+", "/reference:System.dll", "/reference:System.Core.dll", `/reference:${reference}`, `/out:${output}`, source],
        { cwd: directory, timeoutMs: 30_000, label: "native Windows fixture compilation" });
      const encoded = readFileSync(output).toString("base64");
      assert(encoded.length <= 30_000, "Native fixture assembly exceeds its transport bound");
      return encoded;
    } finally { rmSync(directory, { recursive: true, force: true }); }
  })().catch(error => { nativeAssembly = undefined; throw error; });
  return nativeAssembly;
}

async function nativeFixtureCall(expression: string, environment: NodeJS.ProcessEnv, label: string): Promise<string> {
  const assembly = await nativeFixtureAssembly();
  return powershell(`[System.Reflection.Assembly]::Load([Convert]::FromBase64String($env:ER_FIXTURE_WINDOW_ASSEMBLY)) | Out-Null; ${expression}`,
    { ...process.env, ...environment, ER_FIXTURE_WINDOW_ASSEMBLY: assembly }, 30_000, label);
}

export async function withWindowsFixtureRoamingAppData<T>(root: string, run: () => Promise<T>): Promise<T> {
  assertHostedWindowsFixture();
  mkdirSync(join(root, "appdata"), { recursive: true });
  const directory = assertFixtureChild(root, join(root, "appdata"));
  return withFixtureRoamingBinding(directory, {
    read: async () => (await nativeFixtureCall("[Console]::Write([ErUpdateWindows]::RoamingPath())", {}, "read fixture RoamingAppData")).trim(),
    write: async path => { await nativeFixtureCall("[ErUpdateWindows]::SetRoamingPath($env:ER_FIXTURE_ROAMING)", { ER_FIXTURE_ROAMING: path }, "bind fixture RoamingAppData"); },
  }, run);
}

async function nativeWindows(pid: number, expression: string): Promise<string> {
  assert(Number.isSafeInteger(pid) && pid > 0, "Invalid owned host PID");
  return nativeFixtureCall(expression, { ER_FIXTURE_HOST_PID: String(pid) }, "native window observation");
}

export type NativeWindowOwner = Pick<WindowsFixtureProcess, "pid" | "parentPid" | "start" | "executable">;
export interface InstalledWindowEvidence {
  owner: NativeWindowOwner;
  urls: string[];
  names: string[];
  texts: string[];
  windows: Array<{ hwnd: number; className: string; visible: boolean; result: number }>;
  scan: {
    handles: number; accessibleRoots: number; rootFailures: number; visited: number; integerChildren: number;
    resolvedIntegerChildren: number; propertyErrors: number; activationReads: number;
    budgetLimited: boolean; depthLimited: boolean; valueLimited: boolean;
  };
}
interface ExpectedWindowDocument { owner: NativeWindowOwner; canonicalUrl: string; historyText: string }
const WINDOW_SCAN_COUNTS = ["handles", "accessibleRoots", "rootFailures", "visited", "integerChildren", "resolvedIntegerChildren", "propertyErrors", "activationReads"] as const;
const WINDOW_SCAN_LIMITS = ["budgetLimited", "depthLimited", "valueLimited"] as const;

function assertWindowOwner(actual: NativeWindowOwner, expected: NativeWindowOwner): void {
  assert(actual?.pid === expected.pid && actual.parentPid === expected.parentPid && actual.start === expected.start
    && typeof actual.executable === "string" && win32.resolve(actual.executable).toLowerCase() === win32.resolve(expected.executable).toLowerCase(),
  "Native window evidence process identity changed");
}

export function assessInstalledWindowEvidence(evidence: InstalledWindowEvidence, expected: ExpectedWindowDocument) {
  assertWindowOwner(evidence.owner, expected.owner);
  assert(expected.historyText.length > 0, "Native history evidence requires a nonempty fixture marker");
  const origin = new URL(expected.canonicalUrl).origin;
  const canonicalUrl = evidence.urls.includes(expected.canonicalUrl);
  const sameOrigin = evidence.urls.some(value => { try { return new URL(value).origin === origin; } catch { return false; } });
  return { canonicalUrl, historyVisible: evidence.names.some(value => value.includes(expected.historyText)),
    urlStatus: canonicalUrl ? "canonical" : evidence.urls.length === 0 ? "no-urls" : sameOrigin ? "same-origin-other-route" : "other-origin" };
}

/** Diagnostic projection only. Exact raw URL/history checks remain the acceptance gate. */
export function formatInstalledWindowDiagnostic(options: ExpectedWindowDocument & {
  phase: "initial" | "successor"; evidence?: InstalledWindowEvidence; sampledAt?: number; error?: unknown;
  control?: { canonicalUrl: boolean; historyVisible: boolean }; secrets: readonly string[];
}): string {
  const { evidence } = options;
  const checks = evidence ? assessInstalledWindowEvidence(evidence, options)
    : { canonicalUrl: false, historyVisible: false, urlStatus: "no-sample" };
  let truncated = false;
  const safe = (value: string, limit = 2048): string => {
    // Never truncate an unredacted credential-bearing line or a partial token.
    if (Buffer.byteLength(value, "utf8") > 8192) { truncated = true; return "[oversized native value omitted]"; }
    for (const secret of options.secrets) if (secret) value = value.split(secret).join("[redacted]");
    // Redact complete lines separately so the shared error formatter's own tail
    // limit cannot split UTF-8 after multiple short lines expand during redaction.
    const redacted = value.split(/\r?\n/u).map(line => fixtureDiagnosticError(line, options.secrets)).join("\n");
    let result = "", bytes = 0;
    for (const character of redacted) {
      bytes += Buffer.byteLength(character, "utf8");
      if (bytes > limit) { truncated = true; break; }
      result += character;
    }
    return result;
  };
  const record = {
    phase: options.phase, queryStatus: options.error ? "failed" : evidence ? "sampled" : "not-sampled",
    sampledAt: options.sampledAt ?? null, sampleIsHistorical: Boolean(evidence && options.error),
    owner: { pid: options.owner.pid, parentPid: options.owner.parentPid, start: safe(options.owner.start, 128), executable: safe(options.owner.executable) },
    expectedUrl: safe(options.canonicalUrl), historyMarker: safe(options.historyText, 256), checks,
    ...(options.control ? { cdpControl: options.control, forcedAccessibility: false } : {}),
    ...(options.error ? { error: safe(fixtureDiagnosticError(options.error, options.secrets)) } : {}),
    ...(evidence ? { scan: Object.fromEntries([...WINDOW_SCAN_COUNTS, ...WINDOW_SCAN_LIMITS].map(key => [key, evidence.scan[key]])) } : {}),
    counts: { urls: evidence?.urls.length ?? 0, names: evidence?.names.length ?? 0, texts: evidence?.texts.length ?? 0, windows: evidence?.windows.length ?? 0 },
    urls: [] as string[], names: [] as string[], texts: [] as string[], windows: [] as InstalledWindowEvidence["windows"], truncated: false,
  };
  const encoded = () => `${JSON.stringify({ ...record, truncated })}\n`;
  if (evidence) {
    for (const window of evidence.windows) {
      record.windows.push({ hwnd: window.hwnd, className: safe(window.className, 256), visible: window.visible, result: window.result });
      if (Buffer.byteLength(encoded(), "utf8") > 16 * 1024) { record.windows.pop(); truncated = true; break; }
    }
    for (const key of ["urls", "names", "texts"] as const) {
      for (const value of evidence[key]) {
        if (record[key].length >= 128) { truncated = true; break; }
        record[key].push(safe(value));
        if (Buffer.byteLength(encoded(), "utf8") > 16 * 1024) { record[key].pop(); truncated = true; break; }
      }
    }
  }
  const result = encoded();
  assert(Buffer.byteLength(result, "utf8") <= 16 * 1024, "Native window diagnostic exceeds its byte bound");
  return result;
}

async function ownedNativeWindowCall(owner: NativeWindowOwner, expression: string, environment: NodeJS.ProcessEnv = {}): Promise<string> {
  assert(Number.isSafeInteger(owner.pid) && owner.pid > 0 && Number.isSafeInteger(owner.parentPid) && owner.parentPid > 0
    && owner.start.length > 0 && win32.isAbsolute(owner.executable), "Invalid native window owner identity");
  const identity = { pid: owner.pid, parentPid: owner.parentPid, start: owner.start, executable: owner.executable };
  return nativeFixtureCall(`
    $expected=ConvertFrom-Json $env:ER_FIXTURE_WINDOW_OWNER;
    function Confirm-WindowOwner {
      $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+[string]$expected.pid);
      if(!$current -or [int]$current.ParentProcessId -ne [int]$expected.parentPid -or
        $current.CreationDate.ToUniversalTime().ToString('o') -cne $expected.start -or
        !$current.ExecutablePath -or ![IO.Path]::GetFullPath($current.ExecutablePath).Equals([IO.Path]::GetFullPath($expected.executable),[StringComparison]::OrdinalIgnoreCase)){
        throw 'Native window owner identity changed'
      }
    }
    Confirm-WindowOwner;
    ${expression}
    Confirm-WindowOwner;
  `, { ...environment, ER_FIXTURE_WINDOW_OWNER: JSON.stringify(identity) }, "owned native window observation");
}

export async function installedWindowEvidence(owner: NativeWindowOwner): Promise<InstalledWindowEvidence> {
  const text = await ownedNativeWindowCall(owner, `
    $sample=[ErUpdateWindows]::Evidence([int]$expected.pid);
    @{owner=$expected;urls=@($sample.urls);names=@($sample.names);texts=@($sample.texts);windows=@($sample.windows);scan=$sample.scan}|ConvertTo-Json -Depth 6 -Compress
  `);
  assert(Buffer.byteLength(text, "utf8") <= 2 * 1024 * 1024, "Native window evidence exceeds its transport bound");
  const evidence = JSON.parse(text.trim()) as InstalledWindowEvidence;
  assertWindowOwner(evidence.owner, owner);
  for (const key of ["urls", "names", "texts"] as const)
    assert(Array.isArray(evidence[key]) && evidence[key].length <= 4096 && evidence[key].every(value => typeof value === "string" && value.length < 8192), "Invalid native window values");
  assert(evidence.scan && Array.isArray(evidence.windows) && evidence.windows.length <= 64, "Invalid native window scan metadata");
  for (const key of WINDOW_SCAN_COUNTS)
    assert(Number.isSafeInteger(evidence.scan[key]) && evidence.scan[key] >= 0 && evidence.scan[key] <= 65536, "Invalid native window scan count");
  for (const key of WINDOW_SCAN_LIMITS) assert(typeof evidence.scan[key] === "boolean", "Invalid native window scan limit");
  assert(evidence.windows.every(window => Number.isSafeInteger(window.hwnd) && window.hwnd > 0 && typeof window.visible === "boolean"
    && typeof window.className === "string" && window.className.length < 256 && Number.isSafeInteger(window.result)), "Invalid native window metadata");
  return evidence;
}
export interface InstalledRecoveryEvidence {
  owner: NativeWindowOwner;
  documents: number;
  invoked: boolean;
  dialogs: Array<{ documentUrl: string; title: string; notice: string | null; releaseUrl: string | null; closeButtons: number; enabledCloseButtons: number }>;
  scan: InstalledWindowEvidence["scan"];
}
const RECOVERY_TITLE = "Updates";
const RECOVERY_NOTICE = "Installation failed. Open latest Release.";

export function assessInstalledRecoveryEvidence(evidence: InstalledRecoveryEvidence, owner: NativeWindowOwner, canonicalUrl: string): boolean {
  assertWindowOwner(evidence.owner, owner);
  assert(Number.isSafeInteger(evidence.documents) && evidence.documents >= 0 && evidence.documents <= 4096
    && typeof evidence.invoked === "boolean" && Array.isArray(evidence.dialogs) && evidence.dialogs.length <= 16, "Invalid native recovery evidence");
  assert(evidence.scan, "Missing native recovery scan");
  for (const key of WINDOW_SCAN_COUNTS)
    assert(Number.isSafeInteger(evidence.scan[key]) && evidence.scan[key] >= 0 && evidence.scan[key] <= 65536, "Invalid native recovery scan count");
  for (const key of WINDOW_SCAN_LIMITS) assert(typeof evidence.scan[key] === "boolean", "Invalid native recovery scan limit");
  for (const dialog of evidence.dialogs) {
    assert(dialog && [dialog.documentUrl, dialog.title].every(value => typeof value === "string" && value.length < 8192)
      && [dialog.notice, dialog.releaseUrl].every(value => value === null || (typeof value === "string" && value.length < 8192))
      && [dialog.closeButtons, dialog.enabledCloseButtons].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 4096),
    "Invalid native recovery dialog");
  }
  const dialog = evidence.dialogs[0];
  return evidence.documents === 1 && evidence.dialogs.length === 1 && evidence.scan.rootFailures === 0 && evidence.scan.propertyErrors === 0
    && !WINDOW_SCAN_LIMITS.some(key => evidence.scan[key])
    && dialog!.documentUrl === canonicalUrl && dialog!.title === RECOVERY_TITLE && dialog!.notice === RECOVERY_NOTICE
    && dialog!.releaseUrl === LATEST_RELEASE_PAGE && dialog!.closeButtons === 1 && dialog!.enabledCloseButtons === 1;
}

async function installedRecoveryEvidence(owner: NativeWindowOwner, canonicalUrl: string, perform: boolean): Promise<InstalledRecoveryEvidence> {
  const text = await ownedNativeWindowCall(owner, `
    $confirm=[Action]{Confirm-WindowOwner};
    $sample=[ErUpdateWindows]::Recovery([int]$expected.pid,$env:ER_FIXTURE_CANONICAL_URL,$env:ER_FIXTURE_RECOVERY_TITLE,
      $env:ER_FIXTURE_RECOVERY_NOTICE,$env:ER_FIXTURE_RELEASE_URL,($env:ER_FIXTURE_RECOVERY_ACTION -ceq 'close'),$confirm);
    @{owner=$expected;documents=$sample.documents;dialogs=@($sample.dialogs);invoked=$sample.invoked;scan=$sample.scan}|ConvertTo-Json -Depth 6 -Compress
  `, { ER_FIXTURE_CANONICAL_URL: canonicalUrl, ER_FIXTURE_RECOVERY_TITLE: RECOVERY_TITLE, ER_FIXTURE_RECOVERY_NOTICE: RECOVERY_NOTICE,
    ER_FIXTURE_RELEASE_URL: LATEST_RELEASE_PAGE, ER_FIXTURE_RECOVERY_ACTION: perform ? "close" : "observe" });
  assert(Buffer.byteLength(text, "utf8") <= 256 * 1024, "Native recovery evidence exceeds its transport bound");
  return JSON.parse(text.trim()) as InstalledRecoveryEvidence;
}

/** Observe the shared dialog, then rescan and act only on its unique enabled Close. */
export async function closeRecoveryReleaseDialog(owner: NativeWindowOwner, canonicalUrl: string, options: {
  onEvidence?: (evidence: InstalledRecoveryEvidence) => void;
  read?: typeof installedRecoveryEvidence;
} = {}): Promise<boolean> {
  const url = new URL(canonicalUrl);
  assert(url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port && url.pathname === "/"
    && url.hash.startsWith("#/work/") && !url.username && !url.password, "Recovery requires the installed canonical Work URL");
  const read = options.read ?? installedRecoveryEvidence;
  const observed = await read(owner, canonicalUrl, false);
  const ready = assessInstalledRecoveryEvidence(observed, owner, canonicalUrl);
  options.onEvidence?.(observed);
  assert(!observed.invoked, "Recovery observation unexpectedly performed an action");
  if (!ready) return false;
  const acted = await read(owner, canonicalUrl, true);
  const stillReady = assessInstalledRecoveryEvidence(acted, owner, canonicalUrl);
  options.onEvidence?.(acted);
  assert(!acted.invoked || stillReady, "Recovery action lacked the exact dialog evidence");
  return acted.invoked && stillReady;
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
