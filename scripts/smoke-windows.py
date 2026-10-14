"""No-dependency Windows ConPTY startup check; no model request.

API contract: https://learn.microsoft.com/windows/console/creating-a-pseudoconsole-session
"""
import ctypes
from ctypes import wintypes as w
import subprocess
import threading
import time


def check_tui(binary, directory, environment):
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    pointer = ctypes.c_void_p

    class Coord(ctypes.Structure):
        _fields_ = [("x", ctypes.c_short), ("y", ctypes.c_short)]

    class Startup(ctypes.Structure):
        _fields_ = [("cb", w.DWORD), ("reserved", w.LPWSTR), ("desktop", w.LPWSTR),
                    ("title", w.LPWSTR), ("x", w.DWORD), ("y", w.DWORD),
                    ("width", w.DWORD), ("height", w.DWORD), ("cols", w.DWORD),
                    ("rows", w.DWORD), ("fill", w.DWORD), ("flags", w.DWORD),
                    ("show", w.WORD), ("reserved_size", w.WORD),
                    ("reserved_data", pointer), ("stdin", w.HANDLE),
                    ("stdout", w.HANDLE), ("stderr", w.HANDLE)]

    class ExtendedStartup(ctypes.Structure):
        _fields_ = [("startup", Startup), ("attributes", pointer)]

    class Process(ctypes.Structure):
        _fields_ = [("process", w.HANDLE), ("thread", w.HANDLE),
                    ("pid", w.DWORD), ("tid", w.DWORD)]

    signatures = {
        "CreatePipe": ([ctypes.POINTER(w.HANDLE), ctypes.POINTER(w.HANDLE), pointer, w.DWORD], w.BOOL),
        "CreatePseudoConsole": ([Coord, w.HANDLE, w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)], ctypes.c_long),
        "InitializeProcThreadAttributeList": ([pointer, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.c_size_t)], w.BOOL),
        "UpdateProcThreadAttribute": ([pointer, w.DWORD, ctypes.c_size_t, pointer, ctypes.c_size_t, pointer, pointer], w.BOOL),
        "CreateProcessW": ([w.LPCWSTR, w.LPWSTR, pointer, pointer, w.BOOL, w.DWORD, pointer,
                            w.LPCWSTR, ctypes.POINTER(Startup), ctypes.POINTER(Process)], w.BOOL),
        "ReadFile": ([w.HANDLE, pointer, w.DWORD, ctypes.POINTER(w.DWORD), pointer], w.BOOL),
        "WriteFile": ([w.HANDLE, pointer, w.DWORD, ctypes.POINTER(w.DWORD), pointer], w.BOOL),
        "WaitForSingleObject": ([w.HANDLE, w.DWORD], w.DWORD),
        "GetExitCodeProcess": ([w.HANDLE, ctypes.POINTER(w.DWORD)], w.BOOL),
        "TerminateProcess": ([w.HANDLE, w.UINT], w.BOOL),
        "CloseHandle": ([w.HANDLE], w.BOOL),
        "ClosePseudoConsole": ([w.HANDLE], None),
        "DeleteProcThreadAttributeList": ([pointer], None),
    }
    for name, (args, result) in signatures.items():
        fn = getattr(k, name)
        fn.argtypes, fn.restype = args, result

    def require(value):
        if not value:
            raise ctypes.WinError(ctypes.get_last_error())

    input_read, input_write, output_read, output_write, console = (w.HANDLE() for _ in range(5))
    process = Process()
    attributes = None
    initialized = False
    output = bytearray()
    lock = threading.Lock()
    reader = None
    try:
        require(k.CreatePipe(ctypes.byref(input_read), ctypes.byref(input_write), None, 0))
        require(k.CreatePipe(ctypes.byref(output_read), ctypes.byref(output_write), None, 0))
        if k.CreatePseudoConsole(Coord(120, 36), input_read, output_write, 0, ctypes.byref(console)) < 0:
            raise RuntimeError("CreatePseudoConsole failed")
        size = ctypes.c_size_t()
        k.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
        assert size.value, "ConPTY attribute list size unavailable"
        attributes = ctypes.create_string_buffer(size.value)
        require(k.InitializeProcThreadAttributeList(attributes, 1, 0, ctypes.byref(size)))
        initialized = True
        require(k.UpdateProcThreadAttribute(attributes, 0, 0x00020016, console,
                                            ctypes.sizeof(console), None, None))
        startup = ExtendedStartup()
        startup.startup.cb = ctypes.sizeof(ExtendedStartup)
        startup.attributes = ctypes.cast(attributes, pointer)
        command = ctypes.create_unicode_buffer(subprocess.list2cmdline([str(binary)]))
        block = ctypes.create_unicode_buffer("\0".join(f"{key}={value}" for key, value in
            sorted(environment.items(), key=lambda item: item[0].upper())) + "\0\0")
        require(k.CreateProcessW(str(binary), command, None, None, False, 0x00080000 | 0x00000400,
                                 ctypes.cast(block, pointer), str(directory),
                                 ctypes.byref(startup.startup), ctypes.byref(process)))
        for handle in (input_read, output_write):
            k.CloseHandle(handle)
            handle.value = None

        def drain():
            buffer, count = ctypes.create_string_buffer(65536), w.DWORD()
            while k.ReadFile(output_read, buffer, len(buffer), ctypes.byref(count), None) and count.value:
                with lock:
                    output.extend(buffer.raw[:count.value])

        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        sent_exit = False
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            with lock:
                ready = b"Ask Phins" in output
            if ready and not sent_exit:
                count = w.DWORD()
                require(k.WriteFile(input_write, ctypes.create_string_buffer(b"\x04"), 1, ctypes.byref(count), None))
                sent_exit = True
            if k.WaitForSingleObject(process.process, 100) == 0:
                break
        assert sent_exit, "ConPTY composer did not appear: " + output[-2000:].decode(errors="replace")
        assert k.WaitForSingleObject(process.process, 10000) == 0, "ConPTY exit timed out"
        exit_code = w.DWORD()
        require(k.GetExitCodeProcess(process.process, ctypes.byref(exit_code)))
        assert exit_code.value == 0, f"ConPTY exit code {exit_code.value}"
    finally:
        if process.process and k.WaitForSingleObject(process.process, 0) != 0:
            k.TerminateProcess(process.process, 1)
            k.WaitForSingleObject(process.process, 5000)
        if initialized:
            k.DeleteProcThreadAttributeList(attributes)
        if console:
            k.ClosePseudoConsole(console)
        for handle in (input_read, input_write, output_read, output_write, process.thread, process.process):
            if handle:
                k.CloseHandle(handle)
        if reader:
            reader.join(timeout=1)
