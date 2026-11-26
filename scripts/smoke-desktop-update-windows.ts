/** Native OS observations/cleanup for the private Windows updater gate. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { windowsInstallerRegistryId } from "../src/desktop/update-worker";
import { LATEST_RELEASE_PAGE } from "../src/runtime/update-contract";
import { assertFixtureChild, assertHostedWindowsFixture, fixtureDiagnosticError, fixtureProcessIdentity, parseFixtureProcessHistory, parseFixtureWindowsProcesses,
  powershell, retainFixtureProcessHistory, runFixtureCommand, selectFixtureWindowsProcesses, withFixtureRoamingBinding, type WindowsFixtureProcess } from "./smoke-desktop-update-fixture";
export { fixtureProcessIdentity, parseFixtureProcessHistory, parseFixtureWindowsProcesses, retainFixtureProcessHistory, retainFixtureProcessObservation, selectFixtureWindowsProcesses, type WindowsFixtureProcess } from "./smoke-desktop-update-fixture";
export async function fixtureWindowsProcesses(root: string, previouslyOwned: readonly WindowsFixtureProcess[] = [], query: typeof powershell = powershell): Promise<WindowsFixtureProcess[]> {
  const known = parseFixtureProcessHistory(JSON.stringify(previouslyOwned));
  const result = await query(`
    $root=[IO.Path]::GetFullPath($env:ER_FIXTURE_ROOT).TrimEnd('\\')+'\\';
    $known=@{};$latest=@{};
    $knownRows=ConvertFrom-Json ([Console]::In.ReadToEnd());
    foreach($k in $knownRows){
      $id=[int]$k.pid;
      if(!$known.ContainsKey($id)){$known[$id]=@{};$latest[$id]=[string]$k.start}
      $known[$id][[string]$k.start]=$true;
      if([string]::CompareOrdinal($latest[$id],[string]$k.start) -lt 0){$latest[$id]=[string]$k.start}
    }
    $all=@(Get-CimInstance Win32_Process);$byPid=@{};$children=@{};$roots=@{};
    foreach($p in $all){
      $withinRoot=(($p.ExecutablePath -and $p.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) -or
        ($p.CommandLine -and $p.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0));
      $id=[int]$p.ProcessId;
      if($id -le 0){if($withinRoot){throw 'Scoped Windows process PID is unavailable'};continue}
      if(!$byPid.ContainsKey($id)){$byPid[$id]=@()};$byPid[$id]+=$p;
      $parent=[int]$p.ParentProcessId;
      if(!$children.ContainsKey($parent)){$children[$parent]=@()};$children[$parent]+=$id;
      if($withinRoot){$roots[$id]=$true}
    }
    # Unrelated processes remain in this local CIM result only. Their optional
    # metadata is neither validated nor serialized into fixture observations.
    function Scoped-Process([int]$targetId){
      if(!$byPid.ContainsKey($targetId)){return $null}
      if($byPid[$targetId].Count -ne 1){throw 'Duplicate scoped Windows process identity'}
      return $byPid[$targetId][0]
    }
    $starts=@{};
    function Scoped-Start([int]$targetId){
      if($starts.ContainsKey($targetId)){return $starts[$targetId]}
      $p=Scoped-Process $targetId;
      if($null -eq $p -or $p.CreationDate -isnot [datetime]){throw 'Scoped Windows process creation identity is unavailable'}
      $value=$p.CreationDate.ToUniversalTime().ToString('o');$starts[$targetId]=$value;return $value
    }
    $owned=@{};$queue=[Collections.Generic.List[int]]::new();
    foreach($id in @($byPid.Keys)){
      if(!$roots.ContainsKey($id) -and !$known.ContainsKey($id)){continue}
      $birth=Scoped-Start $id;
      if($known.ContainsKey($id) -and [string]::CompareOrdinal($latest[$id],$birth) -gt 0){throw 'Stale Windows process lifetime observed'}
      if($roots.ContainsKey($id) -or ($known.ContainsKey($id) -and $known[$id].ContainsKey($birth))){
        $owned[$id]=$true;$queue.Add($id)
      }
    }
    if($owned.Count -gt 4096){throw 'Windows process observation exceeds its bound'}
    for($index=0;$index -lt $queue.Count;$index++){
      $parent=$queue[$index];$parentBirth=Scoped-Start $parent;
      foreach($id in @($children[$parent])){
        if($null -eq $id){continue}
        $birth=Scoped-Start $id;$order=[string]::CompareOrdinal($parentBirth,$birth);
        if($order -eq 0){throw 'Ambiguous Windows parent creation identity'}
        if($order -lt 0 -and !$owned.ContainsKey($id)){
          $owned[$id]=$true;$queue.Add($id);
          if($owned.Count -gt 4096){throw 'Windows process observation exceeds its bound'}
        }
      }
    }
    $rows=@(foreach($id in $queue){
      $p=Scoped-Process $id;$birth=Scoped-Start $id;
      if($null -eq $p.ParentProcessId){throw 'Scoped Windows process parent identity is unavailable'}
      $parent=[int]$p.ParentProcessId;$parentBirth=$null;
      if($parent -gt 0 -and $byPid.ContainsKey($parent)){
        $observedParentBirth=Scoped-Start $parent;
        $order=[string]::CompareOrdinal($observedParentBirth,$birth);
        if($order -eq 0){throw 'Ambiguous Windows parent creation identity'}
        if($order -lt 0){$parentBirth=$observedParentBirth}
      }
      $row=@{pid=$id;parentPid=$parent;start=$birth;executable=[string]$p.ExecutablePath;withinRoot=$roots.ContainsKey($id);
        worker=([string]$p.CommandLine).Contains('--desktop-update-worker');installer=([string]$p.Name -like '*EasyResearch-*.exe');
        job=([string]$p.Name -match '^(powershell|pwsh).exe$');requestedFrench=([string]$p.CommandLine -match '(?:^|\\s)--lang=fr(?:\\s|$)')};
      if($null -ne $parentBirth){$row.parentStart=$parentBirth};$row
    }); ConvertTo-Json -InputObject $rows -Compress
  `, { ...process.env, ER_FIXTURE_ROOT: root }, 30_000, "owned Windows process observation",
  JSON.stringify(known.map(({ pid, start }) => ({ pid, start }))));
  const current = parseFixtureWindowsProcesses(result);
  const raw = JSON.parse(result) as Array<{ withinRoot: boolean }>;
  assert(raw.every(row => typeof row.withinRoot === "boolean"), "Invalid fixture process root evidence");
  const rooted = new Set(current.filter((_row, index) => raw[index]!.withinRoot).map(fixtureProcessIdentity));
  const rows = selectFixtureWindowsProcesses(current, rooted, known);
  assert(rows.every(row => row.pid !== process.pid && row.pid !== process.ppid), "Fixture process observation included its caller or parent");
  return rows;
}

export async function stopFixtureWindowsProcesses(root: string, previouslyOwned: readonly WindowsFixtureProcess[] = [], io: {
  observe?: typeof fixtureWindowsProcesses;
  stop?: (rows: readonly WindowsFixtureProcess[]) => Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
} = {}): Promise<void> {
  // Every PID is rechecked against creation identity immediately before signalling.
  // The freshly created private root is never reused by another installation.
  const known = new Map(parseFixtureProcessHistory(JSON.stringify(previouslyOwned)).map(row => [fixtureProcessIdentity(row), row]));
  const observe = io.observe ?? fixtureWindowsProcesses;
  for (let attempt = 0; attempt < 5; attempt++) {
    const processes = parseFixtureWindowsProcesses(JSON.stringify(await observe(root, [...known.values()]))); if (!processes.length) return;
    retainFixtureProcessHistory(known, processes);
    if (io.stop) await io.stop(processes);
    else await powershell(`
      $rows=ConvertFrom-Json $env:ER_FIXTURE_PROCESSES;
      foreach($row in $rows){
        $targetPid=0;
        if($null -eq $row -or $row -is [array] -or $row.pid -is [array] -or ![int]::TryParse([string]$row.pid,[ref]$targetPid) -or $targetPid -le 0 -or $row.start -isnot [string] -or [string]::IsNullOrWhiteSpace($row.start)){throw 'Invalid fixture process cleanup identity'}
        if($targetPid -eq $PID -or $targetPid -eq [int]$env:ER_FIXTURE_CALLER_PID -or $targetPid -eq [int]$env:ER_FIXTURE_PARENT_PID){throw 'Refusing to stop a fixture observer or its parent'}
        $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[string]$targetPid);
        if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -ceq $row.start){
          if([int]$p.ParentProcessId -ne [int]$row.parentPid -or
            ($p.ExecutablePath -and $row.executable -and !$p.ExecutablePath.Equals($row.executable,[StringComparison]::OrdinalIgnoreCase))){throw 'Fixture cleanup process identity changed'}
          Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
        }
      }
    `, { ...process.env, ER_FIXTURE_PROCESSES: JSON.stringify(processes), ER_FIXTURE_CALLER_PID: String(process.pid), ER_FIXTURE_PARENT_PID: String(process.ppid) });
    await (io.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))))(500);
  }
  assert.equal((await observe(root, [...known.values()])).length, 0, "Owned Windows fixture processes survived cleanup");
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
// Chromium 148 ui/gfx/win/window_impl.cc ClassRegistrar::RetrieveClassAtom uses
// Chrome_WidgetWin_<registration counter>; the numeric suffix is not an identity.
const NATIVE_WINDOWS = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
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
  [DllImport("user32.dll", SetLastError=true)] static extern bool EnumWindows(EnumCallback callback, IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, EnumCallback callback, IntPtr state);
  [DllImport("user32.dll", SetLastError=true)] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetMenu(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint objectId, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object result);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible parent, int start, int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex=2)] object[] children, out int obtained);
  public static IntPtr[] Windows(int pid,RecoveryEvidence report=null) {
    var list=new List<IntPtr>();
    bool complete=EnumWindows((h,s)=>{uint p; GetWindowThreadProcessId(h,out p); if(p==pid)list.Add(h);return list.Count<=512;},IntPtr.Zero);
    if(!complete && list.Count<=512 && report!=null){report.enumerationError=Marshal.GetLastWin32Error();report.scan.rootFailures++;}
    return list.ToArray();
  }
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
    public int documents;public bool invoked;public int? enumerationError;
    public List<RecoveryDialog> dialogs=new List<RecoveryDialog>();public Scan scan;
    public List<RecoveryWindow> windows=new List<RecoveryWindow>();
  }
  public class RecoveryWindow {
    public long hwnd;public uint ownerPid;public string className="",admission,errorOperation;
    public bool visible;public int? win32Error,accessibilityResult;
  }
  static bool ChromiumWindowClass(string value) {
    const string prefix="Chrome_WidgetWin_";
    if(!value.StartsWith(prefix,StringComparison.Ordinal))return false;
    string suffix=value.Substring(prefix.Length);
    if(suffix.Length==0 || suffix.Length>10 || (suffix.Length>1 && suffix[0]=='0'))return false;
    foreach(char c in suffix)if(c<'0' || c>'9')return false;
    int counter;return Int32.TryParse(suffix,out counter) && counter>=0;
  }
  static RecoveryWindow ReadRecoveryWindow(IntPtr window,int pid) {
    var sample=new RecoveryWindow();sample.hwnd=window.ToInt64();
    uint owner;uint thread=GetWindowThreadProcessId(window,out owner);int ownerError=Marshal.GetLastWin32Error();
    sample.ownerPid=owner;
    var name=new StringBuilder(256);int length=GetClassName(window,name,name.Capacity);int classError=Marshal.GetLastWin32Error();
    sample.className=name.ToString();sample.visible=IsWindowVisible(window);
    // IsWindowVisible false is an ordinary hidden state, not a Win32 failure.
    // Read LastError only for failed APIs which document it; never serialize exceptions.
    if(thread==0){sample.admission="owner-unavailable";sample.errorOperation="owner";sample.win32Error=ownerError;}
    else if(length==0){sample.admission="class-unavailable";sample.errorOperation="class";sample.win32Error=classError;}
    else if(length>=name.Capacity-1)sample.admission="class-truncated";
    else if(owner!=pid)sample.admission="foreign-owner";
    else if(!sample.visible)sample.admission="hidden";
    else if(!ChromiumWindowClass(sample.className))sample.admission="other-class";
    else sample.admission="eligible";
    return sample;
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
    foreach(var window in Windows(pid,scan.result)) {
      if(++values.scan.handles>512){values.scan.budgetLimited=true;break;}
      var sample=ReadRecoveryWindow(window,pid);
      if(scan.result.windows.Count>=64){values.scan.valueLimited=true;break;}
      scan.result.windows.Add(sample);
      // Scan the main top-level client once. Rewalking child HWNDs would count
      // the same document/dialog repeatedly and could authorize an ambiguous Close.
      if(sample.admission!="eligible")continue;
      object value;var iid=new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
      try{
        sample.accessibilityResult=AccessibleObjectFromWindow(window,0xFFFFFFFC,ref iid,out value);
        if(sample.accessibilityResult!=0 || !(value is IAccessible)){sample.admission="accessibility-unavailable";values.scan.rootFailures++;continue;}
        sample.admission="inspected";
        values.scan.accessibleRoots++;Walk((IAccessible)value,values,ref budget,0,scan.Visit);
      }catch(Exception error){sample.admission="accessibility-unavailable";sample.accessibilityResult=Marshal.GetHRForException(error);values.scan.rootFailures++;}
    }
    if(perform && scan.Ready()) {
      confirmOwner();var dialog=scan.result.dialogs[0];
      if(RecoveryScan.EnabledClose(dialog.close,dialog.child)){dialog.close.accDoDefaultAction(dialog.child);scan.result.invoked=true;}
    }
    return scan.result;
  }
  // Native fixture controls: real self-owned HWNDs, no product window or profile.
  delegate IntPtr WindowProcedure(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct WindowClass {
    public uint style;public WindowProcedure procedure;public int classExtra,windowExtra;
    public IntPtr instance,icon,cursor,background;public string menuName,className;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern ushort RegisterClass(ref WindowClass value);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool UnregisterClass(string name,IntPtr instance);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateWindowEx(uint exStyle,string className,string title,uint style,int x,int y,int width,int height,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr parameter);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr DefWindowProc(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int width,int height,uint flags);
  public static object AdmissionControls() {
    int pid=Process.GetCurrentProcess().Id;IntPtr instance=GetModuleHandle(null);
    var classes=new List<string>();var windows=new List<IntPtr>();WindowProcedure procedure=DefWindowProc;
    string[] names={"Chrome_WidgetWin_7","Chrome_WidgetWin_19","Chrome_WidgetWin_23","ErUpdateFixture_"+Guid.NewGuid().ToString("N")};
    try {
      foreach(string name in names) {
        var value=new WindowClass();value.procedure=procedure;value.instance=instance;value.className=name;
        if(RegisterClass(ref value)==0)throw new Exception("Native admission control class registration failed.");
        classes.Add(name);
        IntPtr window=CreateWindowEx(0,name,"Private admission control",0x00CF0000,0,0,120,80,IntPtr.Zero,IntPtr.Zero,instance,IntPtr.Zero);
        if(window==IntPtr.Zero)throw new Exception("Native admission control window creation failed.");
        windows.Add(window);
      }
      // Set only these fixture windows visible, independently of the PowerShell
      // launcher's startup show flags. The product observer never calls this.
      foreach(int index in new int[]{0,1,3})if(!SetWindowPos(windows[index],IntPtr.Zero,0,0,0,0,0x0040|0x0010|0x0004|0x0002|0x0001))throw new Exception("Native admission control visibility failed.");
      var enumerated=new HashSet<IntPtr>(Windows(pid));
      var samples=new Dictionary<string,RecoveryWindow>();
      samples.Add("visibleCounter",ReadRecoveryWindow(windows[0],pid));
      samples.Add("secondCounter",ReadRecoveryWindow(windows[1],pid));
      samples.Add("hidden",ReadRecoveryWindow(windows[2],pid));
      samples.Add("otherClass",ReadRecoveryWindow(windows[3],pid));
      samples.Add("foreignOwner",ReadRecoveryWindow(windows[0],pid+1));
      IntPtr child=CreateWindowEx(0,names[0],"Private child control",0x40000000,0,0,20,20,windows[0],IntPtr.Zero,instance,IntPtr.Zero);
      if(child==IntPtr.Zero)throw new Exception("Native admission child creation failed.");
      windows.Add(child);
      bool childExcluded=!new HashSet<IntPtr>(Windows(pid)).Contains(child);
      if(!DestroyWindow(child))throw new Exception("Native admission child cleanup failed.");
      windows.Remove(child);samples.Add("destroyed",ReadRecoveryWindow(child,pid));
      return new {ownerPid=pid,allTopLevelsEnumerated=windows.TrueForAll(window=>enumerated.Contains(window)),childExcluded=childExcluded,samples=samples};
    } finally {
      bool cleaned=true;
      for(int i=windows.Count-1;i>=0;i--)if(!DestroyWindow(windows[i]))cleaned=false;
      foreach(string name in classes)if(!UnregisterClass(name,instance))cleaned=false;
      GC.KeepAlive(procedure);
      if(!cleaned)throw new Exception("Native admission control cleanup failed.");
    }
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
  enumerationError: number | null;
  windows: InstalledRecoveryWindow[];
  dialogs: Array<{ documentUrl: string; title: string; notice: string | null; releaseUrl: string | null; closeButtons: number; enabledCloseButtons: number }>;
  scan: InstalledWindowEvidence["scan"];
}
export interface InstalledRecoveryWindow {
  hwnd: number;
  ownerPid: number;
  className: string;
  visible: boolean;
  admission: "owner-unavailable" | "class-unavailable" | "class-truncated" | "foreign-owner" | "hidden" | "other-class"
    | "eligible" | "accessibility-unavailable" | "inspected";
  errorOperation: "owner" | "class" | null;
  win32Error: number | null;
  accessibilityResult: number | null;
}
const RECOVERY_WINDOW_ADMISSIONS = ["owner-unavailable", "class-unavailable", "class-truncated", "foreign-owner", "hidden", "other-class",
  "eligible", "accessibility-unavailable", "inspected"];
function chromiumWindowClass(value: string): boolean {
  const match = /^Chrome_WidgetWin_(0|[1-9][0-9]{0,9})$/u.exec(value);
  return Boolean(match && Number(match[1]) <= 0x7fffffff);
}
function assertRecoveryWindow(sample: InstalledRecoveryWindow): void {
  const nativeCode = (value: number | null) => value === null || (Number.isSafeInteger(value) && value >= -0x80000000 && value <= 0xffffffff);
  assert(sample && Number.isSafeInteger(sample.hwnd) && sample.hwnd > 0 && Number.isSafeInteger(sample.ownerPid)
    && sample.ownerPid >= 0 && sample.ownerPid <= 0xffffffff && typeof sample.className === "string" && sample.className.length < 256
    && !/[\0\r\n]/u.test(sample.className) && typeof sample.visible === "boolean" && RECOVERY_WINDOW_ADMISSIONS.includes(sample.admission)
    && [null, "owner", "class"].includes(sample.errorOperation) && nativeCode(sample.win32Error) && nativeCode(sample.accessibilityResult),
  "Invalid native recovery window admission");
  assert((sample.errorOperation === null) === (sample.win32Error === null)
    && (sample.admission === "owner-unavailable") === (sample.errorOperation === "owner")
    && (sample.admission === "class-unavailable") === (sample.errorOperation === "class"),
  "Inconsistent native recovery window error");
  if (["eligible", "accessibility-unavailable", "inspected"].includes(sample.admission)) {
    assert(sample.visible && sample.ownerPid > 0 && chromiumWindowClass(sample.className), "Invalid admitted native recovery window");
  }
  if (sample.admission === "hidden") assert(!sample.visible, "Hidden native recovery window is visible");
  if (sample.admission === "other-class") assert(!chromiumWindowClass(sample.className), "Native recovery class rejection is inconsistent");
  if (sample.admission === "inspected") assert(sample.accessibilityResult === 0, "Native recovery root was not acquired");
  if (!["inspected", "accessibility-unavailable"].includes(sample.admission)) assert(sample.accessibilityResult === null, "Unadmitted native recovery window was inspected");
}
const RECOVERY_TITLE = "Updates";
const RECOVERY_NOTICE = "Installation failed. Open latest Release.";

export function assessInstalledRecoveryEvidence(evidence: InstalledRecoveryEvidence, owner: NativeWindowOwner, canonicalUrl: string): boolean {
  assertWindowOwner(evidence.owner, owner);
  assert(Number.isSafeInteger(evidence.documents) && evidence.documents >= 0 && evidence.documents <= 4096
    && typeof evidence.invoked === "boolean" && Array.isArray(evidence.dialogs) && evidence.dialogs.length <= 16
    && (evidence.enumerationError === null || (Number.isSafeInteger(evidence.enumerationError) && evidence.enumerationError >= -0x80000000 && evidence.enumerationError <= 0xffffffff)),
  "Invalid native recovery evidence");
  assert(evidence.scan, "Missing native recovery scan");
  for (const key of WINDOW_SCAN_COUNTS)
    assert(Number.isSafeInteger(evidence.scan[key]) && evidence.scan[key] >= 0 && evidence.scan[key] <= 65536, "Invalid native recovery scan count");
  for (const key of WINDOW_SCAN_LIMITS) assert(typeof evidence.scan[key] === "boolean", "Invalid native recovery scan limit");
  assert(Array.isArray(evidence.windows) && evidence.windows.length <= 64 && evidence.windows.length <= evidence.scan.handles, "Invalid native recovery window list");
  const handles = new Set<number>();
  for (const sample of evidence.windows) {
    assertRecoveryWindow(sample);
    assert(!handles.has(sample.hwnd), "Duplicate native recovery window"); handles.add(sample.hwnd);
    if (["eligible", "accessibility-unavailable", "inspected"].includes(sample.admission)) {
      assert(sample.ownerPid === owner.pid, "Admitted native recovery window belongs to another process");
    }
  }
  for (const dialog of evidence.dialogs) {
    assert(dialog && [dialog.documentUrl, dialog.title].every(value => typeof value === "string" && value.length < 8192)
      && [dialog.notice, dialog.releaseUrl].every(value => value === null || (typeof value === "string" && value.length < 8192))
      && [dialog.closeButtons, dialog.enabledCloseButtons].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 4096),
    "Invalid native recovery dialog");
  }
  const dialog = evidence.dialogs[0];
  return evidence.documents === 1 && evidence.dialogs.length === 1 && evidence.enumerationError === null
    && evidence.scan.accessibleRoots > 0 && evidence.windows.some(sample => sample.admission === "inspected")
    && evidence.scan.rootFailures === 0 && evidence.scan.propertyErrors === 0
    && !WINDOW_SCAN_LIMITS.some(key => evidence.scan[key])
    && dialog!.documentUrl === canonicalUrl && dialog!.title === RECOVERY_TITLE && dialog!.notice === RECOVERY_NOTICE
    && dialog!.releaseUrl === LATEST_RELEASE_PAGE && dialog!.closeButtons === 1 && dialog!.enabledCloseButtons === 1;
}

async function installedRecoveryEvidence(owner: NativeWindowOwner, canonicalUrl: string, perform: boolean): Promise<InstalledRecoveryEvidence> {
  const text = await ownedNativeWindowCall(owner, `
    $confirm=[Action]{Confirm-WindowOwner};
    $sample=[ErUpdateWindows]::Recovery([int]$expected.pid,$env:ER_FIXTURE_CANONICAL_URL,$env:ER_FIXTURE_RECOVERY_TITLE,
      $env:ER_FIXTURE_RECOVERY_NOTICE,$env:ER_FIXTURE_RELEASE_URL,($env:ER_FIXTURE_RECOVERY_ACTION -ceq 'close'),$confirm);
    @{owner=$expected;documents=$sample.documents;dialogs=@($sample.dialogs);invoked=$sample.invoked;scan=$sample.scan;
      windows=@($sample.windows);enumerationError=$sample.enumerationError}|ConvertTo-Json -Depth 6 -Compress
  `, { ER_FIXTURE_CANONICAL_URL: canonicalUrl, ER_FIXTURE_RECOVERY_TITLE: RECOVERY_TITLE, ER_FIXTURE_RECOVERY_NOTICE: RECOVERY_NOTICE,
    ER_FIXTURE_RELEASE_URL: LATEST_RELEASE_PAGE, ER_FIXTURE_RECOVERY_ACTION: perform ? "close" : "observe" });
  assert(Buffer.byteLength(text, "utf8") <= 256 * 1024, "Native recovery evidence exceeds its transport bound");
  return JSON.parse(text.trim()) as InstalledRecoveryEvidence;
}

/** Keep the existing failure-log envelope valid JSON, even at native scan limits. */
export function projectInstalledRecoveryDiagnostic(evidence: InstalledRecoveryEvidence) {
  let truncated = false;
  const field = (value: string, maximum: number) => {
    if (Buffer.byteLength(value, "utf8") <= maximum) return value;
    truncated = true;
    return "[oversized native value omitted]";
  };
  const counts: Record<string, number> = {};
  for (const window of evidence.windows) counts[window.admission] = (counts[window.admission] ?? 0) + 1;
  const record = {
    owner: { pid: evidence.owner.pid, parentPid: evidence.owner.parentPid, start: field(evidence.owner.start, 128), executable: field(evidence.owner.executable, 1024) },
    documents: evidence.documents, invoked: evidence.invoked, enumerationError: evidence.enumerationError,
    scan: Object.fromEntries([...WINDOW_SCAN_COUNTS, ...WINDOW_SCAN_LIMITS].map(key => [key, evidence.scan[key]])),
    totals: { windows: evidence.windows.length, dialogs: evidence.dialogs.length }, windowAdmissions: counts,
    windows: [] as InstalledRecoveryWindow[], dialogs: [] as InstalledRecoveryEvidence["dialogs"], truncated: false,
  };
  const fits = () => Buffer.byteLength(JSON.stringify({ ...record, truncated }), "utf8") <= 7000;
  for (const dialog of evidence.dialogs) {
    record.dialogs.push({ documentUrl: field(dialog.documentUrl, 1024), title: field(dialog.title, 256),
      notice: dialog.notice === null ? null : field(dialog.notice, 512), releaseUrl: dialog.releaseUrl === null ? null : field(dialog.releaseUrl, 512),
      closeButtons: dialog.closeButtons, enabledCloseButtons: dialog.enabledCloseButtons });
    if (!fits()) { record.dialogs.pop(); truncated = true; break; }
  }
  for (const window of evidence.windows) {
    record.windows.push({ hwnd: window.hwnd, ownerPid: window.ownerPid, className: field(window.className, 256),
      visible: window.visible, admission: window.admission, errorOperation: window.errorOperation,
      win32Error: window.win32Error, accessibilityResult: window.accessibilityResult });
    if (!fits()) { record.windows.pop(); truncated = true; break; }
  }
  record.truncated = truncated;
  assert(fits(), "Native recovery diagnostic exceeds its byte bound");
  return record;
}

/** Disposable hosted Windows control: actual registered HWNDs use the same reader. */
export async function nativeRecoveryWindowAdmissionControls(): Promise<{
  ownerPid: number; allTopLevelsEnumerated: boolean; childExcluded: boolean; samples: Record<string, InstalledRecoveryWindow>;
}> {
  const text = await nativeFixtureCall("[ErUpdateWindows]::AdmissionControls() | ConvertTo-Json -Depth 6 -Compress", {}, "native recovery window admission controls");
  assert(Buffer.byteLength(text, "utf8") <= 16 * 1024, "Native recovery control evidence exceeds its bound");
  const result = JSON.parse(text.trim());
  assert(Number.isSafeInteger(result.ownerPid) && result.ownerPid > 0 && typeof result.allTopLevelsEnumerated === "boolean"
    && typeof result.childExcluded === "boolean" && result.samples && typeof result.samples === "object" && !Array.isArray(result.samples)
    && Object.keys(result.samples).length <= 8, "Invalid native recovery control evidence");
  for (const sample of Object.values(result.samples)) assertRecoveryWindow(sample as InstalledRecoveryWindow);
  return result;
}

/** Observe the shared dialog, then rescan and act only on its unique enabled Close. */
export async function closeRecoveryReleaseDialog(owner: NativeWindowOwner, canonicalUrl: string, options: {
  onEvidence?: (evidence: ReturnType<typeof projectInstalledRecoveryDiagnostic>) => void;
  read?: typeof installedRecoveryEvidence;
} = {}): Promise<boolean> {
  const url = new URL(canonicalUrl);
  assert(url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port && url.pathname === "/"
    && url.hash.startsWith("#/work/") && !url.username && !url.password, "Recovery requires the installed canonical Work URL");
  const read = options.read ?? installedRecoveryEvidence;
  const observed = await read(owner, canonicalUrl, false);
  const ready = assessInstalledRecoveryEvidence(observed, owner, canonicalUrl);
  options.onEvidence?.(projectInstalledRecoveryDiagnostic(observed));
  assert(!observed.invoked, "Recovery observation unexpectedly performed an action");
  if (!ready) return false;
  const acted = await read(owner, canonicalUrl, true);
  const stillReady = assessInstalledRecoveryEvidence(acted, owner, canonicalUrl);
  options.onEvidence?.(projectInstalledRecoveryDiagnostic(acted));
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
