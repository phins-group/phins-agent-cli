"""Offline smoke test of a standalone binary. Python is only a test dependency."""
import errno
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time


def main():
    binary = Path(sys.argv[1]).resolve(strict=True)
    result = {"binary": binary.name, "sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
              "platform": sys.platform, "checks": {}, "inference": False}
    with tempfile.TemporaryDirectory(prefix="phins-binary-smoke-") as temporary:
        home = Path(temporary)
        # An allowlisted environment prevents accidental use of real keys/config.
        env = {key: os.environ[key] for key in
               ("PATH", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC") if key in os.environ}
        env.update(HOME=temporary, USERPROFILE=temporary, TMPDIR=temporary,
                   TEMP=temporary, TMP=temporary, TERM="xterm-256color",
                   PHINS_REDUCED_MOTION="true")
        state = home / ".phins-agent-cli"

        def run(*args):
            return subprocess.run([str(binary), *args], cwd=home, env=env,
                                  stdin=subprocess.DEVNULL, capture_output=True, timeout=45)

        try:
            version = run("--version")
            assert version.returncode == 0, version.stderr.decode(errors="replace")[-2000:]
            result["version"] = version.stdout.decode().strip()
            result["checks"]["version"] = "pass"
            help_result = run("--help")
            assert help_result.returncode == 0
            for command in (b"setup", b"ask", b"resume"):
                assert command in help_result.stdout, f"Missing command: {command!r}"
            result["checks"]["help"] = "pass"
            piped = run()
            assert piped.returncode != 0
            assert b"Interactive mode requires a terminal" in piped.stdout + piped.stderr
            assert (state / ".phins/config/config.json").is_file(), "Wrong profile directory"
            assert not (home / ".phins").exists(), "Touched installed app state"
            result["checks"]["non_terminal_error"] = "pass"
            result["checks"]["isolated_default_profile"] = "pass"
            if os.name == "nt":
                import importlib.util
                spec = importlib.util.spec_from_file_location("windows_smoke", Path(__file__).with_name("smoke-windows.py"))
                windows = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(windows)
                windows.check_tui(binary, home, env)
                result["checks"]["default_tui"] = "pass (native ConPTY; visual Windows Terminal review separate)"
            else:
                check_tui(binary, home, env)
                result["checks"]["default_tui"] = "pass"
        finally:
            # The authenticated local host is detached. Only stop hosts registered
            # inside this freshly created profile, never the installed application.
            for registration in (state / ".phins/state/agents").glob("*.json"):
                data = json.loads(registration.read_text())
                pid = data.get("pid")
                if isinstance(pid, int) and pid > 1:
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
    print(json.dumps(result, indent=2))


def check_tui(binary, home, env):
    import fcntl
    import pty
    import select
    import struct
    import termios

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 120, 0, 0))
    child = subprocess.Popen([str(binary)], cwd=home, env=env, stdin=slave,
                             stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()
    sent_exit = False
    deadline = time.monotonic() + 45
    try:
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                if not chunk:
                    break
                output.extend(chunk)
            if b"Ask Phins" in output and not sent_exit:
                os.write(master, b"\x04")
                sent_exit = True
            if child.poll() is not None:
                break
        assert sent_exit, "TUI composer did not appear: " + output[-2000:].decode(errors="replace")
        assert child.wait(timeout=10) == 0, "TUI did not exit cleanly"
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=10)
        os.close(master)


if __name__ == "__main__":
    main()
