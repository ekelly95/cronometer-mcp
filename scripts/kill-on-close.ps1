<#
    Runs a child process that cannot outlive this one.

    Windows does not end a process's children when the process itself is killed.
    Task Scheduler's "End" (and Stop-ScheduledTask) kills only the task's own
    process — here, PowerShell running run-mcp.ps1 — so the Node server it started
    used to keep running and keep its port, and the next start failed with
    EADDRINUSE.

    A job object marked kill-on-close fixes that at the root. The child is added to
    a job whose only handle this process holds. However this process ends —
    normally, by an exception, or killed outright — Windows closes that handle and
    ends the child. (The Python bridge under the Node server then sees its stdin
    close and exits on its own.)

    The child is added explicitly rather than by putting this process in the job
    and letting children inherit it: when this process already runs inside a job
    that allows silent breakaway, as it can under a host or a CI runner, children
    leave the new job without a word, and the protection silently does nothing.

    Windows only. Dot-source it, then call Invoke-TiedToThisProcess.
#>

function Invoke-TiedToThisProcess {
    param(
        [Parameter(Mandatory)] [string]$FilePath,
        [string[]]$ArgumentList = @()
    )

    if (-not ('CronometerMcp.KillOnClose' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace CronometerMcp
{
    public static class KillOnClose
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimits
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimits
        {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
        private const int JobObjectExtendedLimitInformation = 9;

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        // Deliberately never closed, and not a SafeHandle a finalizer could close:
        // this handle is the mechanism. Windows closes it when the process ends.
        private static IntPtr job = IntPtr.Zero;

        public static void Assign(IntPtr process)
        {
            if (job == IntPtr.Zero)
            {
                IntPtr created = CreateJobObjectW(IntPtr.Zero, null);
                if (created == IntPtr.Zero) throw new Win32Exception();
                ExtendedLimits limits = new ExtendedLimits();
                limits.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if (!SetInformationJobObject(created, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
                    throw new Win32Exception();
                job = created;
            }
            if (!AssignProcessToJobObject(job, process)) throw new Win32Exception();
        }
    }
}
'@
    }

    $start = [Diagnostics.ProcessStartInfo]::new($FilePath)
    foreach ($argument in $ArgumentList) { $start.ArgumentList.Add($argument) }
    $start.UseShellExecute = $false
    $child = [Diagnostics.Process]::Start($start)
    try {
        [CronometerMcp.KillOnClose]::Assign($child.Handle)
    } catch {
        # Reported, not fatal: a server that will not start is worse than one that
        # has to be stopped by hand.
        Write-Warning "Stopping this process will not stop $FilePath`: $($_.Exception.Message)"
    }
    $child.WaitForExit()
    return $child.ExitCode
}
