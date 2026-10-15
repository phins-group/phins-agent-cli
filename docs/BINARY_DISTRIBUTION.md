# PHINs Agent — standalone builds

Download an archive from the [0.1.2 hackathon preview](https://github.com/phins-group/phins-agent-cli/releases/tag/v0.1.2),
extract it, and run **`phins`** (`phins.exe` on Windows). No arguments open the
TUI. Bun, pnpm and agent package installation are unnecessary. Follow the
[Quick Start](QUICKSTART.md) for masked Nebius setup and the bundled demo.

## Choose a build

| Operating system | Direct download | Minimum system |
| --- | --- | --- |
| **macOS** | [Apple Silicon / ARM64](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.2/phins-0.1.2-local-darwin-arm64.tar.gz) · [Intel / x64](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.2/phins-0.1.2-local-darwin-x64.tar.gz) | macOS 13+ |
| **Linux** | [x64](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.2/phins-0.1.2-local-linux-x64.tar.gz) · [ARM64](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.2/phins-0.1.2-local-linux-arm64.tar.gz) | glibc 2.30+, libstdc++ and libgcc |
| **Windows** | [Windows x64 ZIP](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.2/phins-0.1.2-local-windows-x64.zip) | Windows 10 1809+ / Windows 11, Windows Terminal |

Alpine/musl and Windows ARM64 are unsupported. The executable reports
`0.1.2-local`. macOS binaries are ad-hoc signed, not notarized; Windows binaries
are unsigned. The optional Windows FFF binding imports `VCRUNTIME140.dll` and
remains disabled by default.

## Run

Open a terminal in the extracted folder. **macOS / Linux:**

```sh
./phins setup
./phins
```

**Windows PowerShell:**

```powershell
.\phins.exe setup
.\phins.exe
```

Setup masks the key and recommends NVIDIA Nemotron on Nebius Token Factory.
Use `/setup` or `/models` in the TUI to change settings. Open a project by
passing its path to the executable. Piped input receives an explicit error
with the `phins ask` alternative. Use a real terminal; do not double-click
the executable to choose a project.

State defaults to `~/.phins-agent-cli` (`%USERPROFILE%\.phins-agent-cli` on
Windows). `PHINS_LOCAL_HOME` selects another profile. Keys are stored locally,
not in an encrypted OS keychain. No API key or model weights are supplied;
submitting a task can incur provider charges. A project's tests need their
own runtime/tools. The bundled demo needs Node.js 22+ and Git only.

## Verify and qualification scope

Compare the archive with the release's `SHA256SUMS`. Each archive also includes
an executable checksum and build metadata. Maintainers can run the included
offline smoke helper with Python 3.11+:

```sh
python3 scripts/smoke-binary.py /absolute/path/to/phins
```

It checks version/help, the isolated default profile, rejection of a
non-terminal TUI launch, no-argument TUI startup/clean exit, and opening a Git
project by path and from its own working directory. The path fixture contains
spaces and a non-ASCII character. Windows uses
native ConPTY. This makes no inference request. A ConPTY check does not replace
human visual review in Windows Terminal.

The [validation report](QUICKSTART_VALIDATION.md) distinguishes native macOS,
Rosetta, Linux containers/emulation and Windows checks. The reviewed macOS
sandbox and independent verification remain the qualified coding-demo path.
Other startup checks do not qualify every tool, terminal, hardened workflow or
provider inference on that platform. A requested unavailable sandbox fails closed.

## Source and licenses

Keep all accompanying project, dependency and runtime notices. Optional
corresponding-source and notice-only assets are supplied with the release;
see [runtime source and rebuilding](RUNTIME_SOURCE.md). PHINs licensing does
not replace third-party terms.

Developers can build from the approved source with Node.js 22+, Bun 1.3.12,
pnpm 10.26.0 and Git:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm build:all
pnpm build --target windows-x64
pnpm build:package my-local-binary-candidate
```

The native build writes `dist/phins` (Windows: `dist/phins.exe`); `build:all`
writes five target directories. Cross-compilation may download a matching Bun
runtime. No model catalog or inference is requested during a build.

Packaging additionally needs Python 3.11+. The default creates **review-only**
archives and refuses to overwrite an existing candidate. The packager's
`--release-review` option requires a completed local record binding all target
hashes, retained runtime notices and source assets; it does not upload or
publish. Owner publication authorization remains a separate requirement.

## Native build checks

The [native build workflow](https://github.com/phins-group/phins-agent-cli/actions/workflows/build.yml)
compiles and tests on macOS ARM64/Intel, Linux ARM64/x64 and Windows x64
runners, with pinned Bun/pnpm and a frozen dependency lockfile. It uses no
provider key and makes no model requests. Release archives are packaged and
checked separately; a successful build alone does not qualify all coding tools.

Windows runtime permissions are checked through Win32 ACL APIs. PowerShell
script execution and an elevated administrator session are not required for
this permission check. Broad access still causes the runtime to refuse access.

For native Windows compilation, use the pinned Bun x64 baseline runtime selected
by the native workflow. This avoids Bun 1.3.12 trying to extract a different
compiler executable during the build. Judge downloads need no Bun installation.
