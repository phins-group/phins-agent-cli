"""Exercise the real compiled uninstaller in disposable PTY/ConPTY fixtures."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def confirm(binary, directory, env, all_data=False, answer=b"y"):
    arguments = ["uninstall", *(["--all"] if all_data else [])]
    prompt = b"Uninstall and permanently delete" if all_data else b"Uninstall PHINs Agent?"
    if os.name == "nt":
        def after_exit():
            # A user's terminal stays open after the command. Closing ConPTY
            # early kills attached helpers before their post-exit work finishes.
            deadline = time.monotonic() + 20
            while binary.exists() and time.monotonic() < deadline:
                time.sleep(.1)
            errors = [file.read_text() for file in directory.glob("phins-uninstall-*/error.txt")]
            assert not binary.exists(), "Windows post-exit deletion failed: " + "\n".join(errors)
        return module("windows_console", "smoke-windows.py").check_tui(
            binary, directory, env, arguments, prompt=prompt, keys=answer,
            on_exit=after_exit if answer else None)
    import fcntl
    import pty
    import select
    import struct
    import termios
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 160, 0, 0))
    process = subprocess.Popen([str(binary), *arguments], cwd=directory, env=env,
                               stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()
    responded = False
    try:
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    break
            if prompt in output and not responded:
                time.sleep(.2)
                os.write(master, answer + b"\r")
                responded = True
            if process.poll() is not None:
                break
        assert responded, "Uninstall confirmation did not appear: " + output[-3000:].decode(errors="replace")
        assert process.wait(timeout=10) == 0, output[-3000:].decode(errors="replace")
        return output.decode(errors="replace")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        os.close(master)


def main():
    binary = Path(sys.argv[1]).resolve(strict=True)
    packager = module("packager", "package-binaries.py")
    result = {"platform": sys.platform, "checks": {}, "inference": False}
    for all_data in (False, True):
        with tempfile.TemporaryDirectory(prefix="phins-uninstall-smoke-") as temporary:
            home = Path(temporary).resolve() / "User's home à"
            home.mkdir()
            env = {key: os.environ[key] for key in
                   ("PATH", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC", "SystemDrive",
                    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "ALLUSERSPROFILE") if key in os.environ}
            env.update(HOME=str(home), USERPROFILE=str(home), TMPDIR=str(home),
                       TEMP=str(home), TMP=str(home), TERM="xterm-256color",
                       LOCALAPPDATA=str(home / "AppData/Local"))
            if os.name == "nt":
                powershell = Path(env['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
                probe = subprocess.run([str(powershell), '-NoProfile', '-NonInteractive', '-Command',
                                        "[Console]::Out.WriteLine('PHINS_POWERSHELL_READY')"],
                                       env=env, capture_output=True, timeout=20)
                assert probe.returncode == 0 and b'PHINS_POWERSHELL_READY' in probe.stdout, \
                    'Windows PowerShell prerequisite failed: ' + (probe.stdout + probe.stderr).decode(errors='replace')
            build = json.loads(binary.with_name("build.json").read_text())
            version = build["version"]
            shown_version = subprocess.check_output([str(binary), "--version"], cwd=home, env=env, timeout=30).decode().strip()
            assert shown_version == f"phins v{version}", shown_version
            target = build["target"]
            label = f"phins-{version}-{target}"
            base = home / "AppData/Local/PHINsAgent" if os.name == "nt" else home / ".local/share/phins-agent-cli"
            bundle = base / label
            bundle.mkdir(parents=True)
            executable = bundle / binary.name
            shutil.copy2(binary, executable)
            docs = bundle / "docs"
            docs.mkdir()
            (docs / "guide.md").write_text("unmodified release file\n")
            (bundle / "NOTICE").write_text("notice fixture\n")
            packager.write_install_inventory(bundle, version, target)
            (bundle / ".phins-install").write_text("a" * 64)
            # Added/changed files deliberately remain outside the release inventory.
            (bundle / "NOTICE").write_text("user-modified fixture\n")
            added = bundle / ".local/demo/source.js"
            added.parent.mkdir(parents=True)
            added.write_text("user demo source\n")
            project = home / "User project à"
            project.mkdir()
            (project / "source.ts").write_text("user project source\n")
            profile = home / ".phins-agent-cli"
            profile.mkdir(exist_ok=True)
            (profile / "settings-fixture.txt").write_text("private fixture settings\n")
            (profile / "sessions-fixture.db").write_text("synthetic session fixture\n")
            if os.name == "nt":
                launcher = base / "bin/phins.cmd"
                launcher.parent.mkdir()
                launcher.write_bytes((f'@rem PHINs Agent installer launcher\r\n@"%~dp0..\\{label}\\phins.exe" %*\r\n').encode("ascii"))
                # Directory junctions need no elevation; the external project must survive --all.
                linked = subprocess.run([str(Path(env['SystemRoot']) / 'System32/cmd.exe'),
                                         '/d', '/c', 'mklink', '/J', str(profile / 'linked-project'), str(project)],
                                        env=env, capture_output=True, timeout=15)
                assert linked.returncode == 0, linked.stderr.decode(errors="replace")
            else:
                launcher = home / ".local/bin/phins"
                launcher.parent.mkdir(parents=True)
                launcher.symlink_to(executable)
                (profile / "linked-project").symlink_to(project)
            rejected = subprocess.run([str(executable), "uninstall", "--all"], cwd=home, env=env,
                                      stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
            assert rejected.returncode != 0 and b"Confirmation is required" in rejected.stdout + rejected.stderr
            assert executable.is_file() and launcher.exists()
            result["checks"]["non_terminal_rejected"] = "pass"
            cancelled = confirm(executable, home, env, all_data, answer=b"")
            assert "Cancelled. Nothing removed." in cancelled and executable.is_file() and launcher.exists()
            assert (profile / "sessions-fixture.db").is_file()
            result["checks"]["default_confirmation_cancels"] = "pass"
            completed = confirm(executable, home, env, all_data)
            deadline = time.monotonic() + 20
            while executable.exists() and time.monotonic() < deadline:
                time.sleep(.1)
            diagnostics = [file.read_text() for file in home.glob("phins-uninstall-*/error.txt")]
            assert not executable.exists(), completed[-3000:] + "\n" + "\n".join(diagnostics)
            if os.name == "nt":
                deadline = time.monotonic() + 5
                while list(home.glob("phins-uninstall-*")) and time.monotonic() < deadline:
                    time.sleep(.1)
                assert not list(home.glob("phins-uninstall-*")), 'Windows helper did not finish its cleanup'
            assert not launcher.exists()
            assert not (docs / "guide.md").exists()
            assert not (bundle / "INSTALL_MANIFEST.json").exists()
            assert not (bundle / ".phins-install").exists()
            assert (bundle / "NOTICE").read_text() == "user-modified fixture\n"
            assert added.read_text() == "user demo source\n"
            assert (project / "source.ts").read_text() == "user project source\n"
            assert profile.exists() != all_data
            if not all_data:
                assert (profile / "sessions-fixture.db").is_file()
            result["checks"]["uninstall_all" if all_data else "uninstall_keep_profile"] = "pass"
            result["checks"]["modified_and_added_files_preserved"] = "pass"
            result["checks"]["user_project_preserved"] = "pass"
            result["version"] = version
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
