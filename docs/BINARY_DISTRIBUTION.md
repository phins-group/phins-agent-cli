# PHINs Agent — standalone builds

> FROM IDEAS to IMPACT

The executable is **`phins`** (`phins.exe` on Windows). Running it without
arguments opens the existing TUI in the current project. Bun, Node.js and pnpm
are not needed to start the executable. Your project's tests still need their
own language runtime, dependencies and tools such as Git.

These are local review builds. Public distribution still requires completion of
the native/runtime license review. A compiled target does not imply that all
features have been qualified on that operating system.

## Choose a build

| Build | Intended system | Format |
| --- | --- | --- |
| `darwin-arm64` | Apple Silicon, macOS 13+ | `.tar.gz` |
| `darwin-x64` | Intel, macOS 13+ | `.tar.gz` |
| `linux-arm64` | ARM64 Linux with glibc 2.30+ | `.tar.gz` |
| `linux-x64` | x64 Linux with glibc 2.30+ | `.tar.gz` |
| `windows-x64` | Windows 10 1809+ / Windows 11, Windows Terminal | `.zip` |

Linux builds require system `libstdc++` and `libgcc`; they do not target Alpine/
musl. The glibc floor comes from the bundled FFF library's versioned symbols.
macOS minimums are recorded in the executable/native libraries. The Windows
runtime minimum follows [Bun's platform requirements](https://bun.sh/docs/installation),
checked 2026-10-14; native Windows execution remains to be verified. The FFF DLL
also imports `VCRUNTIME140.dll`; FFF remains disabled by default on Windows.
Windows ARM64 is not in this build matrix.

## Run

Extract the archive and open a terminal. On macOS/Linux:

```sh
./phins
```

On Windows, open PowerShell in Windows Terminal:

```powershell
.\phins.exe
```

Once its directory is on your `PATH`, the command on all platforms is:

```sh
phins
```

Inside the TUI, use `/setup` to enter a masked API key and choose a model.
Nebius setup recommends NVIDIA Nemotron. `/models` changes the selection.
The CLI uses the same configuration:

```sh
phins setup
phins /path/to/reviewed/project
phins ask "Inspect this repository and explain its test command" --project /path/to/project
phins --help
```

Use a real terminal; piped input gets an explicit error with the `phins ask`
alternative. Do not double-click the binary to select a project. macOS artifacts
are ad-hoc signed, not notarized; Windows artifacts are not Authenticode signed.
Do not disable operating-system security globally to run a review build.

The standalone profile is `~/.phins-agent-cli` (`%USERPROFILE%\.phins-agent-cli`
on Windows). Override it with `PHINS_LOCAL_HOME`. Settings and the local key
database are beneath its `.phins` directory. Source launches continue to use
`.local/home` unless overridden. Existing explicit configuration and test-profile
overrides take precedence. No API key or model weights are shipped; submitting
a task can incur provider charges. Keys are stored locally, not in an encrypted
OS keychain.

## Build from source

Use the pinned workspace dependencies and Bun 1.3.12 for comparable artifacts:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm build:all
pnpm build --target windows-x64
pnpm build:package my-local-binary-candidate
```

`pnpm build` creates `dist/phins` or `dist/phins.exe` for the build host.
`build:all` creates one directory per target under `dist/`. Cross-compilation
can download the matching public Bun runtime. Native dependencies are installed
for all supported architectures; model metadata is not fetched during the build.
Each directory has `build.json`, a SHA-256 checksum and the build input graph.

Packaging needs Python 3.11+ on the build machine. It writes a new directory under
`artifacts/`, refuses replacement of an existing candidate, and includes project
notices plus installed and pinned upstream license texts, a smoke-test helper
and the unresolved notice inventory. Supplemental text hashes and Bun runtime
version must match before packaging.
It never commits, uploads, signs with an owner identity, or publishes anything.
Keep the archive's notices with the executable when redistributing an approved
release; the current notice collection is not yet a complete clearance.

## Verify

Compare archive and executable hashes with their `SHA256SUMS`. Run the included
source validation script against an extracted binary:

```sh
python3 scripts/smoke-binary.py /absolute/path/to/phins
```

The offline smoke test uses a fresh profile. It checks version/help, rejects a
non-terminal TUI launch, and on macOS/Linux opens the TUI with **no arguments**,
waits for its input composer and exits with Ctrl+D. It makes no inference call.
On Windows it checks the CLI/profile only; manually open the TUI in Windows
Terminal and verify `/setup`, `/models`, input focus, resize and normal exit.

The macOS engine's reviewed sandbox and independent verification workflow remain
the qualified competition demo path. Linux/Windows startup checks do not qualify
that workflow, provider inference, all native tools or every terminal emulator.
The runtime must keep failing closed when a requested sandbox is unavailable.
