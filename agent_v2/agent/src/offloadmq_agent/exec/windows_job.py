"""Windows process-tree ownership independent of the original parent's lifetime.

Create children suspended, assign them, then resume. Closing our job handle also
kills its members if the runner exits unexpectedly. No breakaway is enabled.
"""

from __future__ import annotations

import ctypes as ct
from ctypes import wintypes as wt
import time
from typing import Any

import psutil


class _BasicLimits(ct.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ct.c_int64),
        ("PerJobUserTimeLimit", ct.c_int64),
        ("LimitFlags", ct.c_uint32),
        ("MinimumWorkingSetSize", ct.c_size_t),
        ("MaximumWorkingSetSize", ct.c_size_t),
        ("ActiveProcessLimit", ct.c_uint32),
        ("Affinity", ct.c_size_t),
        ("PriorityClass", ct.c_uint32),
        ("SchedulingClass", ct.c_uint32),
    ]


class _IoCounters(ct.Structure):
    _fields_ = [
        (name, ct.c_uint64)
        for name in (
            "ReadOperationCount",
            "WriteOperationCount",
            "OtherOperationCount",
            "ReadTransferCount",
            "WriteTransferCount",
            "OtherTransferCount",
        )
    ]


class _ExtendedLimits(ct.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimits),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ct.c_size_t),
        ("JobMemoryLimit", ct.c_size_t),
        ("PeakProcessMemoryUsed", ct.c_size_t),
        ("PeakJobMemoryUsed", ct.c_size_t),
    ]


class _Accounting(ct.Structure):
    _fields_ = [
        ("TotalUserTime", ct.c_int64),
        ("TotalKernelTime", ct.c_int64),
        ("ThisPeriodTotalUserTime", ct.c_int64),
        ("ThisPeriodTotalKernelTime", ct.c_int64),
        ("TotalPageFaultCount", ct.c_uint32),
        ("TotalProcesses", ct.c_uint32),
        ("ActiveProcesses", ct.c_uint32),
        ("TotalTerminatedProcesses", ct.c_uint32),
    ]


def _kernel_api() -> Any:
    api = getattr(ct, "WinDLL")("kernel32", use_last_error=True)
    signatures = {
        "CreateJobObjectW": ([ct.c_void_p, wt.LPCWSTR], wt.HANDLE),
        "SetInformationJobObject": (
            [wt.HANDLE, ct.c_int, ct.c_void_p, wt.DWORD],
            wt.BOOL,
        ),
        "OpenProcess": ([wt.DWORD, wt.BOOL, wt.DWORD], wt.HANDLE),
        "AssignProcessToJobObject": ([wt.HANDLE, wt.HANDLE], wt.BOOL),
        "TerminateJobObject": ([wt.HANDLE, wt.UINT], wt.BOOL),
        "QueryInformationJobObject": (
            [wt.HANDLE, ct.c_int, ct.c_void_p, wt.DWORD, ct.c_void_p],
            wt.BOOL,
        ),
        "CloseHandle": ([wt.HANDLE], wt.BOOL),
    }
    for name, (args, result) in signatures.items():
        function = getattr(api, name)
        function.argtypes = args
        function.restype = result
    return api


def _last_error() -> OSError:
    return OSError(getattr(ct, "get_last_error")(), "Windows job operation failed")


class WindowsJob:
    def __init__(self) -> None:
        self._api = _kernel_api()
        self._handle = self._api.CreateJobObjectW(None, None)
        if not self._handle:
            raise _last_error()
        limits = _ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
        if not self._api.SetInformationJobObject(
            self._handle, 9, ct.byref(limits), ct.sizeof(limits)
        ):
            error = _last_error()
            self.close()
            raise error

    def assign_and_resume(self, pid: int) -> None:
        process = self._api.OpenProcess(0x0101, False, pid)  # SET_QUOTA | TERMINATE
        if not process:
            raise _last_error()
        try:
            if not self._api.AssignProcessToJobObject(self._handle, process):
                raise _last_error()
            psutil.Process(pid).resume()
        finally:
            self._api.CloseHandle(process)

    def terminate(self) -> None:
        if not self._api.TerminateJobObject(self._handle, 1):
            raise _last_error()
        deadline = time.monotonic() + 10
        while True:
            accounting = _Accounting()
            if not self._api.QueryInformationJobObject(
                self._handle, 1, ct.byref(accounting), ct.sizeof(accounting), None
            ):
                raise _last_error()
            if accounting.ActiveProcesses == 0:
                return
            if time.monotonic() >= deadline:
                raise TimeoutError("Windows job members did not terminate")
            time.sleep(0.01)

    def close(self) -> None:
        if self._handle:
            self._api.CloseHandle(self._handle)
            self._handle = None
