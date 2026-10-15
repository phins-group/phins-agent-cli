"""Standalone startup test without model inference. Python is a test dependency."""
import errno
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request


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
                check = windows.check_tui
                check(binary, home, env)
                result["checks"]["default_tui"] = "pass (native ConPTY; visual Windows Terminal review separate)"
            else:
                check = check_tui
                check(binary, home, env)
                result["checks"]["default_tui"] = "pass"
            project = home / "Sample project à"
            project.mkdir()
            (project / "README.md").write_text("# Standalone startup fixture\n", encoding="utf-8")
            initialized = subprocess.run(["git", "-c", "init.defaultBranch=main", "init", "--quiet", str(project)],
                                         cwd=home, env=env, capture_output=True, timeout=15)
            assert initialized.returncode == 0, "Git fixture initialization failed"
            check(binary, home, env, [str(project)])
            result["checks"]["explicit_project_with_spaces_and_unicode"] = "pass"
            check(binary, project, env)
            result["checks"]["repository_cwd"] = "pass"
            registrations = [json.loads(file.read_text()) for file in (state / ".phins/state/agents").glob("*.json")]
            assert any(os.path.normcase(entry["directory"]) == os.path.normcase(str(project.resolve()))
                       for entry in registrations), "Wrong project selected"
            result["checks"]["project_identity"] = "pass"
            registration = next(entry for entry in registrations
                                if os.path.normcase(entry["directory"]) == os.path.normcase(str(project.resolve())))
            session = empty_session(registration, project)
            check(binary, project, env, ["--session", session], expect_epilogue=True)
            result["checks"]["resumed_session_exit_epilogue"] = "pass"
        except Exception:
            if os.name == "nt":
                # This profile is created without credentials. Retain bounded,
                # redacted host errors when startup fails before registration.
                for file in (state / ".phins/log").glob("*.log"):
                    if file.is_symlink() or not file.is_file():
                        continue
                    detail = file.read_text(errors="replace")[-4000:]
                    detail = re.sub(r"(?i)(Basic|Bearer)\s+[A-Za-z0-9+/=_-]+", r"\1 [redacted]", detail)
                    detail = re.sub(r"\b[a-fA-F0-9]{32,}\b", "[redacted-id]", detail)
                    print("Isolated host diagnostic:", detail, file=sys.stderr)
            raise
        finally:
            # The authenticated local host is detached. Only stop hosts registered
            # inside this freshly created profile, never the installed application.
            for registration in (state / ".phins/state/agents").glob("*.json"):
                data = json.loads(registration.read_text())
                pid = data.get("pid")
                if isinstance(pid, int) and pid > 1:
                    try:
                        if os.name == "nt":
                            windows.stop_runtime(pid)
                        else:
                            os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
    print(json.dumps(result, indent=2))


def empty_session(registration, project):
    """Create an actual empty session in this test profile; never send a prompt."""
    assert re.fullmatch(r"http://127\.0\.0\.1:[0-9]+", registration["url"])
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    headers = {"authorization": "Basic " + base64.b64encode(
                   ("phins:" + registration["password"]).encode()).decode(),
               "x-phins-service-generation": registration["id"],
               "content-type": "application/json"}

    def post(route, body):
        request = urllib.request.Request(registration["url"] + route,
                                         data=json.dumps(body).encode(), headers=headers, method="POST")
        with opener.open(request, timeout=10) as response:
            return json.loads(response.read(65536))

    client = post("/api/agent/client/open", {"kind": "headless"})["clientID"]
    headers["x-phins-agent-client"] = client
    try:
        return post("/api/session", {"location": {"directory": str(project.resolve())},
                                     "title": "Console exit fixture"})["data"]["id"]
    finally:
        post("/api/agent/client/close", {"background": False})


def check_tui(binary, home, env, arguments=(), expect_epilogue=False):
    import fcntl
    import pty
    import select
    import struct
    import termios

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 120, 0, 0))
    child = subprocess.Popen([str(binary), *arguments], cwd=home, env=env, stdin=slave,
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
            ready = b"Ask Phins" in output and (not expect_epilogue or b"Console exit fixture" in output)
            if ready and not sent_exit:
                os.write(master, b"\x04")
                sent_exit = True
            if child.poll() is not None:
                break
        assert sent_exit, "TUI composer did not appear: " + output[-2000:].decode(errors="replace")
        assert child.wait(timeout=10) == 0, "TUI did not exit cleanly"
        if expect_epilogue:
            assert b"Goodbye!" in output, "Session exit epilogue was not rendered"
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=10)
        os.close(master)


if __name__ == "__main__":
    main()
