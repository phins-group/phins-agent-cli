"""Package five compiled targets with notices. Never uploads."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import stat
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
TARGETS = ("darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64")


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def load_notice_sources():
    sources = json.loads((ROOT / "notices/supplemental-notices.json").read_text())
    for entry in sources["packages"] + sources["runtimes"]:
        file = ROOT / entry["path"]
        if file.resolve().parent != (ROOT / "notices").resolve() or digest(file) != entry["sha256"]:
            raise ValueError(f'Invalid supplemental notice: {entry["path"]}')
    return sources


def copy_notices(inputs, destination, sources, bun_version):
    packages = {}
    for name in inputs:
        if "node_modules/" not in name:
            continue
        directory = (ROOT / name).parent
        # Some distributions have a nested package.json containing only "type".
        # Its enclosing named package still owns the files and license.
        while directory != ROOT:
            file = directory / "package.json"
            metadata = json.loads(file.read_text()) if file.is_file() else {}
            if metadata.get("name") and metadata.get("version"):
                break
            directory = directory.parent
        if directory == ROOT or directory in packages:
            continue
        package = {"name": metadata["name"], "version": metadata["version"],
                   "declaredLicense": metadata.get("license"), "notices": []}
        label = re.sub(r"[^\w.@-]", "_", f'{package["name"]}@{package["version"]}')
        for file in sorted(directory.iterdir()):
            if not file.is_file() or not re.match(r"^(LICEN[SC]E|COPYING|NOTICE)([.-]|$)", file.name, re.I):
                continue
            target = destination / "dependencies" / label / file.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, target)
            package["notices"].append({"path": target.relative_to(destination).as_posix(),
                                       "sha256": digest(target)})
        for entry in sources["packages"]:
            if package["name"] not in entry["names"] or package["version"] != entry["version"]:
                continue
            target = destination / "dependencies" / label / Path(entry["path"]).name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / entry["path"], target)
            package["notices"].append({"path": target.relative_to(destination).as_posix(),
                                       "sha256": digest(target), "source": entry["source"],
                                       "basis": entry["basis"]})
        packages[directory] = package
    runtimes = []
    for entry in sources["runtimes"]:
        if entry["name"] != "Bun" or entry["version"] != bun_version:
            continue
        target = destination / "dependencies" / f"bun@{bun_version}" / Path(entry["path"]).name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / entry["path"], target)
        runtimes.append({**entry, "path": target.relative_to(destination).as_posix()})
    inventory = sorted(packages.values(), key=lambda p: (p["name"], p["version"]))
    (destination / "DEPENDENCIES.json").write_text(json.dumps({
        "scope": "Installed and pinned upstream license evidence, not redistribution clearance",
        "packages": inventory,
        "runtimes": runtimes,
        "missingNoticeText": [f'{p["name"]}@{p["version"]}' for p in inventory if not p["notices"]],
        "remainingReview": ["Bun runtime and statically linked libraries",
                            "Native libraries and grammar/WASM transitive notices",
                            "Exact provenance and missing upstream notices"],
    }, indent=2) + "\n")


def archive_directory(directory, destination, windows):
    files = sorted(file for file in directory.rglob("*") if file.is_file())
    if windows:
        with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED) as archive:
            for file in files:
                info = zipfile.ZipInfo(file.relative_to(directory.parent).as_posix(), (2026, 10, 14, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, file.read_bytes(), compresslevel=9)
    else:
        # Normalize timestamps/owners and preserve executable mode after extraction.
        with destination.open("xb") as output, gzip.GzipFile(fileobj=output, mode="wb", mtime=0, filename="") as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as archive:
                for file in files:
                    content = file.read_bytes()
                    info = tarfile.TarInfo(file.relative_to(directory.parent).as_posix())
                    info.size = len(content)
                    info.mode = 0o755 if file.name == "phins" else 0o644
                    archive.addfile(info, io.BytesIO(content))


def write_install_inventory(bundle, version, target):
    files = sorted(bundle.rglob("*"))
    if any(file.is_symlink() for file in files):
        raise ValueError("Release inventory must not contain symbolic links")
    inventory = {"formatVersion": 1, "version": version, "target": target,
                 "files": [{"path": file.relative_to(bundle).as_posix(), "sha256": digest(file)}
                           for file in files if file.is_file() and file != bundle / "INSTALL_MANIFEST.json"]}
    (bundle / "INSTALL_MANIFEST.json").write_text(json.dumps(inventory, indent=2) + "\n")


def write_windows_launcher(bundle):
    template = (ROOT / "scripts/windows-launcher.cmd").read_text()
    content = template.replace("__PHINS_EXECUTABLE__", "%~dp0phins.exe")
    (bundle / "phins.cmd").write_bytes(content.replace("\n", "\r\n").encode("ascii"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("name", nargs="?", default="binary-candidate")
    parser.add_argument("--release-review", type=Path,
                        help="Completed local review binding exact binaries, notices and source")
    args = parser.parse_args()
    name = args.name
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", name):
        raise ValueError("Use a simple, new candidate directory name")
    builds = []
    sources = load_notice_sources()
    for target in TARGETS:
        directory = ROOT / "dist" / target
        build = json.loads((directory / "build.json").read_text())
        expected = "phins.exe" if target.startswith("windows") else "phins"
        if build["target"] != target or build["binary"] != expected or digest(directory / expected) != build["sha256"]:
            raise ValueError(f"Changed or invalid build: {target}")
        if sum(e["name"] == "Bun" and e["version"] == build["bun"] for e in sources["runtimes"]) != 1:
            raise ValueError(f'Exactly one Bun {build["bun"]} notice is required')
        builds.append((target, directory, build))
    review = None
    if args.release_review:
        review = json.loads(args.release_review.read_text())
        if review.get("status") != "pass" or review.get("blockers") != []:
            raise ValueError("Binary redistribution review is incomplete")
        if not review.get("sourceAssets") or not review.get("noticeSha256"):
            raise ValueError("Reviewed source assets and runtime notices are required")
        if digest(ROOT / "notices/runtime-sources.json") != review["sourceIndexSha256"]:
            raise ValueError("Reviewed runtime-source index changed")
        for target, _, build in builds:
            if review["binarySha256"].get(target) != build["sha256"]:
                raise ValueError(f"Review does not cover this binary: {target}")
        for entry in review["sourceAssets"]:
            if digest(Path(entry["path"])) != entry["sha256"]:
                raise ValueError("Reviewed corresponding-source asset changed")
        notices = Path(review["noticeDirectory"]).resolve(strict=True)
        actual = {file.relative_to(notices).as_posix(): digest(file)
                  for file in notices.rglob("*") if file.is_file() and not file.is_symlink()}
        if any(file.is_symlink() for file in notices.rglob("*")) or actual != review["noticeSha256"]:
            raise ValueError("Reviewed runtime notices changed")
    destination = ROOT / "artifacts" / name
    destination.parent.mkdir(exist_ok=True, mode=0o700)
    destination.mkdir(mode=0o700)  # Refuse to replace any previous candidate.
    summaries = []
    for target, directory, build in builds:
        label = f'phins-{build["version"]}-{target}'
        bundle = destination / label
        bundle.mkdir(mode=0o700)
        for file in (build["binary"], "build.json", "SHA256SUMS"):
            shutil.copyfile(directory / file, bundle / file)
        if build["binary"] == "phins":
            (bundle / "phins").chmod(0o755)
        for file in ("LICENSE", "NOTICE", "PROVENANCE.md", "THIRD_PARTY.md"):
            shutil.copyfile(ROOT / file, bundle / file)
        readme = (ROOT / "docs/BINARY_DISTRIBUTION.md").read_text()
        for guide in ("QUICKSTART.md", "QUICKSTART_VALIDATION.md", "RUNTIME_SOURCE.md"):
            readme = readme.replace(f"]({guide})", f"](docs/{guide})")
        (bundle / "README.md").write_text(readme)
        (bundle / "notices").mkdir()
        for file in ("third-party-source-LICENSE", "seq-queue-LICENSE", "node-forge-LICENSE",
                     "packages__http-recorder__LICENSE", "dependency-licenses.json"):
            shutil.copyfile(ROOT / "notices" / file, bundle / "notices" / file)
        # Keep referenced attribution evidence and its local documentation links.
        demo_inputs = json.loads((ROOT / "examples/live/UPSTREAM.json").read_text())["files"]
        demo_files = ["examples/live/ms-pr111/" + item["path"] for item in demo_inputs]
        for file in (*demo_files, "examples/live/UPSTREAM.json", "examples/live/ms-pr111/license.md",
                     "examples/live/ms-pr111-strict/test/regression.test.mjs",
                     "configs/nebius.example.json", "scripts/demo.mjs",
                     "docs/QUICKSTART.md", "docs/QUICKSTART_VALIDATION.md",
                     "docs/SUBMISSION.md", "docs/ARCHITECTURE.md", "docs/BENCHMARK.md",
                     "docs/JUDGING_GUIDE.md", "docs/LOCAL_OPERATION.md",
                     "docs/DEMO_SCRIPT.md", "docs/BINARY_DISTRIBUTION.md",
                     "scripts/smoke-binary.py", "scripts/smoke-windows.py", "scripts/smoke-uninstall.py", "scripts/package-binaries.py", "docs/evidence/live-20261014.json",
                     "docs/evidence/ms-pr111.patch", "docs/evidence/ms-pr111-before.tap",
                     "docs/evidence/ms-pr111-after.tap", "docs/evidence/ms-pr111-correction.tap"):
            target_file = bundle / file
            target_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / file, target_file)
        inputs = json.loads((directory / "build-inputs.json").read_text())["inputs"]
        copy_notices(inputs, bundle, sources, build["bun"])
        if review:
            inventory_path = bundle / "DEPENDENCIES.json"
            inventory = json.loads(inventory_path.read_text())
            if inventory["missingNoticeText"]:
                raise ValueError(f"Dependency notice missing: {inventory['missingNoticeText']}")
            shutil.copytree(notices, bundle / "runtime-notices")
            shutil.copyfile(ROOT / "notices/runtime-sources.json", bundle / "notices/runtime-sources.json")
            shutil.copyfile(ROOT / "docs/RUNTIME_SOURCE.md", bundle / "docs/RUNTIME_SOURCE.md")
            inventory.update(scope="Release build-input inventory with retained license texts",
                             remainingReview=[], sourceAvailability="notices/runtime-sources.json",
                             reviewLimitations=review["limitations"])
            inventory_path.write_text(json.dumps(inventory, indent=2) + "\n")
            (bundle / "RELEASE_STATUS.txt").write_text(
                "PHINS AGENT HACKATHON PREVIEW\n"
                "Keep all accompanying notices. Runtime sources are available with this release.\n"
                "A completed build is not proof of coding-workflow qualification on this OS.\n"
                "See docs/QUICKSTART.md and docs/QUICKSTART_VALIDATION.md.\n"
                "No API key, provider balance, hosted access or model weights are included.\n")
        else:
            (bundle / "REVIEW_STATUS.txt").write_text(
                "LOCAL REVIEW BUILD - NOT CLEARED FOR PUBLIC REDISTRIBUTION\n"
                "A completed build is not proof of runtime qualification on this OS.\n"
                "See README.md and DEPENDENCIES.json for limitations and outstanding notices.\n"
                "No API key, provider balance, hosted access or model weights are included.\n")
        # Uninstall removes only unchanged release files; user-created files stay.
        if target.startswith("windows"):
            shutil.copyfile(ROOT / "scripts/windows-launcher.cmd", bundle / "scripts/windows-launcher.cmd")
            write_windows_launcher(bundle)
        write_install_inventory(bundle, build["version"], target)
        windows = target.startswith("windows")
        archive = destination / (label + (".zip" if windows else ".tar.gz"))
        archive_directory(bundle, archive, windows)
        summaries.append({"target": target, "archive": archive.name,
                          "sha256": digest(archive), "bytes": archive.stat().st_size,
                          "binarySha256": build["sha256"]})
        print(f"Packaged {archive.name}", flush=True)
    (destination / "SHA256SUMS").write_text("".join(f'{s["sha256"]}  {s["archive"]}\n' for s in summaries))
    (destination / "packages.json").write_text(json.dumps({
        "status": "release-candidate" if review else "local-review-only",
        "uploaded": False, "packages": summaries,
    }, indent=2) + "\n")
    print(destination)


if __name__ == "__main__":
    main()
