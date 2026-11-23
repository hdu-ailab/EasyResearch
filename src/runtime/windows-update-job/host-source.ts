/** Fixed source compiled at build time by the Windows .NET Framework compiler.
 * PowerShell loads its embedded assembly; operation values remain private UTF-8 data.
 */
export const WINDOWS_UPDATE_JOB_BOOTSTRAP = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Record-BootstrapStage([string]$phase) {
  try {
    $line = '{"phase":"' + $phase + '","guardPid":' + $PID + ',"utcMs":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '}' + [Environment]::NewLine
    [System.IO.File]::AppendAllText([System.IO.Path]::Combine($env:TEMP, 'bootstrap.jsonl'), $line, [System.Text.UTF8Encoding]::new($false))
  } catch { }
}
try {
  Record-BootstrapStage 'entry'
  $reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false, $true), $false, 4096, $true)
  $line = $reader.ReadLine()
  Record-BootstrapStage 'assembly-read'
  if ($null -eq $line -or $line.Length -gt 131072) { exit 70 }
  Record-BootstrapStage 'assembly-load-start'
  [System.Reflection.Assembly]::Load([Convert]::FromBase64String($line)) | Out-Null
  Record-BootstrapStage 'assembly-load-complete'
  exit ([EasyResearch.WindowsUpdateJobHost]::Run($reader))
} catch { exit 70 }
`;

export const WINDOWS_UPDATE_JOB_SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace EasyResearch {
  public sealed class JobRequest {
    public int version;
    public string nonce;
    public string directory;
    public string command;
    public string commandLine;
    public string cwd;
    public string environment;
    public int cleanupTimeoutMs;
  }

  public static class WindowsUpdateJobHost {
    const uint CREATE_SUSPENDED = 0x4;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000;
    const uint CREATE_NO_WINDOW = 0x8000000;
    const uint KILL_ON_JOB_CLOSE = 0x2000;
    const uint CANCEL_EXIT = 0xC000013A;
    const uint WAIT_OBJECT_0 = 0;
    const uint WAIT_TIMEOUT = 258;
    static readonly IntPtr InvalidHandle = new IntPtr(-1);

    sealed class NativeFailure : Exception {
      public readonly string Phase;
      public readonly int Code;
      public NativeFailure(string phase, int code) { Phase = phase; Code = code; }
    }
    static Exception Failed(string phase) { return new NativeFailure(phase, Marshal.GetLastWin32Error()); }
    static void BootstrapStage(string phase) {
      // Fixed, bounded initialization metadata only. It is never custody proof
      // and never contains the request, command, environment or nonce.
      try {
        string line = new JavaScriptSerializer().Serialize(new { phase = phase,
          guardPid = Process.GetCurrentProcess().Id, utcMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
        File.AppendAllText(Path.Combine(Environment.GetEnvironmentVariable("TEMP"), "bootstrap.jsonl"), line + "\n", new UTF8Encoding(false));
      } catch { }
    }

    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
      public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
      public int Size; public string Reserved; public string Desktop; public string Title;
      public uint X; public uint Y; public uint XSize; public uint YSize;
      public uint XCountChars; public uint YCountChars; public uint FillAttribute; public uint Flags;
      public ushort ShowWindow; public ushort ReservedSize; public IntPtr ReservedBytes;
      public IntPtr Input; public IntPtr Output; public IntPtr Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {
      public StartupInfo StartupInfo; public IntPtr Attributes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
      public IntPtr Process; public IntPtr Thread; public uint ProcessId; public uint ThreadId;
    }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
      public long PerProcessTime; public long PerJobTime; public uint Flags;
      public UIntPtr MinWorkingSet; public UIntPtr MaxWorkingSet; public uint ActiveProcessLimit;
      public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
      public ulong ReadOperations; public ulong WriteOperations; public ulong OtherOperations;
      public ulong ReadBytes; public ulong WriteBytes; public ulong OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
      public BasicLimit Basic; public IoCounters Io;
      public UIntPtr ProcessMemory; public UIntPtr JobMemory; public UIntPtr PeakProcessMemory; public UIntPtr PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
      public long UserTime; public long KernelTime; public long PeriodUserTime; public long PeriodKernelTime;
      public uint PageFaults; public uint TotalProcesses; public uint ActiveProcesses; public uint TerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string path, uint access, uint share, ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);

    sealed class Control {
      public volatile bool Start;
      public volatile bool Cancel;
      public void Read(StreamReader reader, string nonce) {
        try {
          while (true) {
            string line = ReadLine(reader, 128);
            if (line == "start:" + nonce && !Start && !Cancel) { Start = true; continue; }
            // EOF, malformed input and explicit cancellation all fail closed.
            Cancel = true;
            return;
          }
        } catch { Cancel = true; }
      }
    }

    static string ReadLine(StreamReader reader, int limit) {
      StringBuilder value = new StringBuilder();
      while (true) {
        int c = reader.Read();
        if (c == -1) return value.Length == 0 ? null : value.ToString();
        if (c == 10) return value.ToString();
        if (value.Length >= limit) throw new InvalidDataException();
        value.Append((char)c);
      }
    }

    static void PrivateDirectory(string path) {
      DirectoryInfo directory = new DirectoryInfo(path);
      if (!directory.Exists || (directory.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException();
      SecurityIdentifier owner = WindowsIdentity.GetCurrent().User;
      DirectorySecurity security = directory.GetAccessControl();
      IdentityReference actualOwner = security.GetOwner(typeof(SecurityIdentifier));
      SecurityIdentifier administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
      // An elevated token can create directories with Administrators as default
      // owner. Restrict that owned directory to the actual token user as well.
      if (!owner.Equals(actualOwner) && !(administrators.Equals(actualOwner) &&
          new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))) throw new IOException();
      DirectorySecurity restricted = new DirectorySecurity();
      restricted.SetOwner(owner);
      restricted.SetAccessRuleProtection(true, false);
      InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
      restricted.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
      restricted.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
      directory.SetAccessControl(restricted);
    }

    static void Publish(JobRequest request, string name, object value) {
      string path = Path.Combine(request.directory, name);
      string temporary = path + ".pending";
      byte[] bytes = new UTF8Encoding(false, true).GetBytes(new JavaScriptSerializer().Serialize(value));
      using (FileStream file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
        file.Write(bytes, 0, bytes.Length); file.Flush(true);
      }
      File.Move(temporary, path);
    }

    static uint Active(IntPtr job) {
      Accounting info;
      if (!QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw Failed("query-job");
      return info.ActiveProcesses;
    }

    static bool RootExited(ProcessInfo process) {
      if (process.Process == IntPtr.Zero) return true;
      uint result = WaitForSingleObject(process.Process, 0);
      if (result != WAIT_OBJECT_0 && result != WAIT_TIMEOUT) throw Failed("wait-root");
      return result == WAIT_OBJECT_0;
    }

    static ProcessInfo CreateSuspended(JobRequest request, IntPtr job) {
      IntPtr output = IntPtr.Zero, error = IntPtr.Zero, input = IntPtr.Zero;
      IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero, jobs = IntPtr.Zero, environment = IntPtr.Zero;
      bool initialized = false;
      try {
        IntPtr current = GetCurrentProcess();
        if (!DuplicateHandle(current, GetStdHandle(-11), current, out output, 0, true, 2)) throw Failed("duplicate-stdout");
        if (!DuplicateHandle(current, GetStdHandle(-12), current, out error, 0, true, 2)) throw Failed("duplicate-stderr");
        SecurityAttributes security = new SecurityAttributes();
        security.Length = Marshal.SizeOf(typeof(SecurityAttributes)); security.Inherit = true;
        input = CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0x80, IntPtr.Zero);
        if (input == InvalidHandle) throw Failed("open-null");
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
        if (size == IntPtr.Zero) throw Failed("size-attributes");
        attributes = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size)) throw Failed("initialize-attributes");
        initialized = true;
        handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
        Marshal.WriteIntPtr(handles, 0, input); Marshal.WriteIntPtr(handles, IntPtr.Size, output); Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, error);
        // Only target stdio is inherited. Neither the job nor the private control
        // pipe may be kept alive by descendants after their guard dies.
        if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw Failed("set-handle-list");
        // Windows 10+ PROC_THREAD_ATTRIBUTE_JOB_LIST makes assignment part of
        // CreateProcess itself. Even a guard death before this call returns or
        // before ResumeThread cannot strand an unowned suspended executable.
        // Reject unsupported attributes BEFORE creation; never fall back to a
        // create-then-assign sequence or any unassigned process creation.
        jobs = Marshal.AllocHGlobal(IntPtr.Size);
        Marshal.WriteIntPtr(jobs, job);
        if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw Failed("set-job-list");
        StartupInfoEx startup = new StartupInfoEx();
        startup.StartupInfo.Size = Marshal.SizeOf(typeof(StartupInfoEx));
        startup.StartupInfo.Flags = 0x100;
        startup.StartupInfo.Input = input; startup.StartupInfo.Output = output; startup.StartupInfo.Error = error;
        startup.Attributes = attributes;
        environment = Marshal.StringToHGlobalUni(request.environment);
        ProcessInfo process;
        if (!CreateProcessW(request.command, new StringBuilder(request.commandLine), IntPtr.Zero, IntPtr.Zero, true,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
            environment, request.cwd, ref startup, out process)) throw Failed("create-process");
        return process;
      } finally {
        if (initialized) DeleteProcThreadAttributeList(attributes);
        if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
        if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
        if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
        if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
        if (input != IntPtr.Zero && input != InvalidHandle) CloseHandle(input);
        if (output != IntPtr.Zero) CloseHandle(output);
        if (error != IntPtr.Zero) CloseHandle(error);
      }
    }

    public static int Run(StreamReader reader) {
      JobRequest request = null;
      IntPtr job = IntPtr.Zero;
      ProcessInfo process = new ProcessInfo();
      bool empty = false;
      string failure = null;
      string phase = "request", failurePhase = null, errorType = null;
      int? nativeError = null, hresult = null;
      Control control = new Control();
      try {
        JavaScriptSerializer serializer = new JavaScriptSerializer(); serializer.MaxJsonLength = 1048576;
        BootstrapStage("request-read-start");
        request = serializer.Deserialize<JobRequest>(ReadLine(reader, 1048576));
        BootstrapStage("request-read-complete");
        if (request == null || request.version != 1 || request.nonce == null || request.nonce.Length != 64 ||
            request.cleanupTimeoutMs < 1 || request.cleanupTimeoutMs > 60000 ||
            request.commandLine == null || request.commandLine.Length > 32766 ||
            request.environment == null || !request.environment.EndsWith("\0\0", StringComparison.Ordinal)) throw new InvalidDataException();
        phase = "private-directory"; PrivateDirectory(request.directory);
        phase = "create-job";
        job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw Failed(phase);
        ExtendedLimit limit = new ExtendedLimit(); limit.Basic.Flags = KILL_ON_JOB_CLOSE;
        phase = "set-job-limits";
        if (!SetInformationJobObject(job, 9, ref limit, (uint)Marshal.SizeOf(typeof(ExtendedLimit)))) throw Failed(phase);
        if (Active(job) != 0) throw new IOException();
        Thread input = new Thread(delegate() { control.Read(reader, request.nonce); });
        input.IsBackground = true; input.Start();
        phase = "publish-ready"; Publish(request, "ready.json", new { version = 1, nonce = request.nonce, guardPid = Process.GetCurrentProcess().Id });
        BootstrapStage("ready-published");
        phase = "wait-admission";
        Stopwatch admission = Stopwatch.StartNew();
        while (!control.Start && !control.Cancel) {
          if (admission.ElapsedMilliseconds > 30000) { control.Cancel = true; break; }
          Thread.Sleep(10);
        }
        if (!control.Cancel) {
          phase = "create-process"; process = CreateSuspended(request, job);
          // Successful creation already established kernel job custody atomically.
          phase = "resume-thread";
          if (!control.Cancel && ResumeThread(process.Thread) == UInt32.MaxValue) throw Failed(phase);
        }
        phase = "wait-job";
        Stopwatch cancellation = null;
        while (true) {
          if (control.Cancel && cancellation == null) {
            cancellation = Stopwatch.StartNew();
            if (!TerminateJobObject(job, CANCEL_EXIT)) throw Failed("terminate-job");
          }
          if (Active(job) == 0 && RootExited(process)) { empty = true; break; }
          if (cancellation != null && cancellation.ElapsedMilliseconds >= request.cleanupTimeoutMs) throw new IOException();
          Thread.Sleep(10);
        }
      } catch (Exception error) {
        failure = "native-job-failed";
        NativeFailure native = error as NativeFailure;
        failurePhase = native == null ? phase : native.Phase;
        if (native != null) nativeError = native.Code;
        hresult = error.HResult; errorType = error.GetType().Name;
        // Every created process, including a suspended one whose creation has
        // not yet returned, is already owned by this job. Never signal a PID.
        Stopwatch cleanup = Stopwatch.StartNew();
        int timeout = request == null ? 1000 : Math.Max(1, Math.Min(request.cleanupTimeoutMs, 60000));
        try {
          if (job != IntPtr.Zero) TerminateJobObject(job, CANCEL_EXIT);
          while (cleanup.ElapsedMilliseconds < timeout) {
            if ((job == IntPtr.Zero || Active(job) == 0) && RootExited(process)) { empty = true; break; }
            Thread.Sleep(10);
          }
        } catch { empty = false; }
      }
      try {
        uint? code = null;
        if (empty && process.Process != IntPtr.Zero) {
          uint exitCode;
          if (!GetExitCodeProcess(process.Process, out exitCode)) { empty = false; failure = "native-job-failed"; failurePhase = "get-exit-code"; nativeError = Marshal.GetLastWin32Error(); }
          else code = exitCode;
        }
        if (request != null) Publish(request, "receipt.json", new {
          version = 1, nonce = request.nonce, guardPid = Process.GetCurrentProcess().Id,
          jobEmpty = empty, rootPid = process.ProcessId, code = code, failure = failure,
          diagnostics = new { phase = failurePhase, win32Error = nativeError, hresult = hresult, errorType = errorType }
        });
      } catch { failure = "receipt-failed"; }
      finally {
        if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
        if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
        if (job != IntPtr.Zero) CloseHandle(job);
      }
      return empty && failure == null ? 0 : 71;
    }
  }
}
`;
