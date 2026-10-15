# Quick Start validation

## Windows PowerShell compatibility — 2026-10-15

[Native installer CI](https://github.com/phins-group/phins-agent-cli/actions/runs/38739475934)
passes six jobs: macOS ARM64/Intel, Linux ARM64/x64, and Windows x64 on both
Windows Server 2022 and 2025. Windows installs from scratch and repeats under
Windows PowerShell 5.1, then checks PowerShell 7 onboarding. Nine Windows
preflight regressions cover architecture metadata, an actual 32-bit PowerShell
process on x64 Windows, and clear rejection of reported versions below 5.1.
The ARM64/x86 cases are input fixtures, not physical-machine qualification.

The installer uses native Windows architecture variables, avoiding the null
RuntimeInformation property reported on an owner's PowerShell 5.1 machine.
Windows tar extracts the pinned archive, including notice paths beyond 260
characters. Every installed file is independently checked against the bundled
SHA-256 inventory. Real TUI/project/session/exit, the intentional 22-pass/5-fail
baseline, confirmed uninstall and file/profile/project preservation also pass.

These checks run without credentials or inference. The binaries and v0.1.2
release assets are unchanged; use the current installers linked from Quick Start.
This is CI console/filesystem evidence, not testing every consumer Windows version
or a new human visual/model-coding qualification.

## v0.1.2 confirmed uninstall — 2026-10-15

[Native CI](https://github.com/phins-group/phins-agent-cli/actions/runs/38712390661)
passes actual compiled startup and uninstall on macOS ARM64/Intel, Linux ARM64/x64
and Windows x64. Disposable profiles and real PTY/ConPTY input verify default-No
cancellation, non-terminal refusal, profile retention, default-profile deletion,
managed launcher/binary removal and preservation of changed/added release files
and external projects. Windows additionally preserves the project reached by a
profile directory junction. Paths contain spaces, an apostrophe and a non-ASCII
character. Twenty-three focused uninstall tests pass on macOS; platform-specific
unit skips are covered by the actual Windows launcher/compiled-binary checks.

Windows uses the included `phins.cmd` launcher to finish executable removal after
the binary exits and return a meaningful status. Direct `phins.exe uninstall`
refuses with the launcher instructions. Loose binaries, source checkouts, Git
repository roots and custom/linked profiles are preserved. `--all` applies only
to the default profile; other downloaded copies and custom profiles are retained.

The last broad local suite before final Windows launcher refinements recorded
1,941 passes, 14 skips and zero failures. Current focused type checks and the
five-target native startup/uninstall run pass afterward. These checks use no API
key and perform no model inference; historical coding evidence below is unchanged.
Human visual Windows Terminal review and broader Linux/Windows hardened coding
qualification remain separate from this console/filesystem validation.

The current one-command installers also pass [exact public-archive CI](https://github.com/phins-group/phins-agent-cli/actions/runs/38717977588)
on all five targets: download/checksums, repeat installation, actual installed
TUI/project/session/exit, the 22-pass/5-fail historical baseline, and confirmed
uninstall/profile/project preservation. Windows additionally passes native
Windows PowerShell onboarding and protection of an unrelated command or changed
executable. Its installer probes at the final installation path to avoid moving
an executable immediately after running it. This bootstrap follow-up is on main;
the v0.1.2 tag and release assets remain unchanged. No API key or inference is used.

## v0.1.1 Windows compatibility update — 2026-10-15

[Native CI](https://github.com/phins-group/phins-agent-cli/actions/runs/38679314958)
built and tested all five targets: macOS ARM64/Intel, Linux ARM64/x64 and
Windows x64. Each actual executable passed version/help, non-terminal rejection,
isolated-profile startup, opening a Git project by explicit path and by cwd,
and resuming a real empty session with a visible exit epilogue. The project
path contains spaces and a non-ASCII character; its identity is checked while
the authenticated runtime is live. The runtime may remove its registration
when the last client exits.

Windows passed six ACL tests, including rejection of an Everyone grant and
operation with an empty PATH and invalid PowerShell module path. Runtime
permissions now use Win32 APIs. Windows exit output is printed on the restored
screen before native console destruction; renderer cleanup is idempotent.

These checks make **no model inference request**. Builds/installations and a
first repository scan can download pinned dependencies or ripgrep. This is
startup/console qualification, not a claim that every Windows/Linux coding tool,
hardened sandbox, provider request or physical OS version has been qualified.
The GitHub Windows runner is not a human visual review of the owner's Windows
Terminal. Use `/exit`; Ctrl+D remains outside Windows shortcut qualification.

The macOS preparation suite recorded **1,907 passes, 14 skips and zero failures**
before the last Windows console changes. The affected lifecycle, renderer and
command regressions passed afterward. Exact release-archive checks are recorded
separately in the release notes. Native CI binaries and maintainer cross-built
release binaries have separate checksums and runtime checks.

The original model repair footage and inference figures below remain historical
evidence; they are not new inference runs of v0.1.1.

## Original v0.1.0 qualification

Checked on **2026-10-14**. The guide uses standalone release archives; starting
PHINs needs no Bun, pnpm or agent package installation. Node.js 22+ and Git
are needed only for the bundled repository's demo/tests.

## Platform checks

The offline helper opens the actual executable with a fresh profile, checks
version/help and non-terminal rejection, waits for the no-argument TUI composer
and exits cleanly. It makes no model request.

| Target | Observed startup result |
| --- | --- |
| macOS ARM64 | Passed natively on Apple Silicon |
| macOS x64 | Passed under Rosetta; no physical Intel-machine claim |
| Linux ARM64 | Passed in an unprivileged, network-disabled container |
| Linux x64 | Passed in an unprivileged, network-disabled container under emulation |
| Windows x64 | Passed on GitHub's native Windows runner: Ready composer, typed `/exit`, exit 0 and runtime cleanup |

Windows Terminal human visual review and Linux/Windows hardened coding
workflows remain outside this qualification. The macOS sandbox/independent-check
profile is the recommended competition demo path. Binaries are not notarized
on macOS or Authenticode-signed on Windows.

[The successful Windows workflow](https://github.com/phins-group/phins-agent-cli/actions/runs/38586278238)
checks the downloaded archive's checksum before running it. Earlier Ctrl+D
ConPTY trials returned exit 1; that shortcut is not qualified on Windows.
Use the documented `/exit` command. This check uses real console input/output,
redirected diagnostic stderr and no provider credentials or inference.

## Provider and coding evidence

The preset and implementation confirm endpoint
`https://api.tokenfactory.nebius.com/v1`, optional credential variable
`NEBIUS_API_KEY`, and model **`nvidia/nemotron-3-super-120b-a12b`**. Masked setup
needs no environment variables. A real Nebius account model-catalog refresh
and selected model were verified; saved fallback lists are not connection proof.
No key value is included in this report.

The genuine recorded demo used macOS ARM64 executable SHA-256
`fdfb8a28db31a8b8ba650609f20944676a89b602fa2b98976cd3699d12e789eb`.
Its outcome was **22/27 → 26/27 → 27/27**, with actual
Nebius/NVIDIA inference, a failed tool command and recovery, protected tests,
and independent verification. The release also includes a Windows runtime-metadata ACL compatibility fix.
That earlier result is not a new inference run of the rebuilt archive or a
guarantee for every prompt. See the
[benchmark and evidence](BENCHMARK.md).

A separate fresh anonymous checkout was also tested with Node.js 24.12.0,
Bun 1.3.12, pnpm 10.26.0 and Git 2.50.1 on macOS 27.0.1 Apple Silicon:

| Check | Actual result |
| --- | --- |
| Frozen source installation | Passed using the existing dependency cache |
| Preparation and original regression command | 22 passed / 5 failed / 27 total; expected exit 1 |
| Masked setup and source TUI | Real catalog refresh passed; TUI reached Ready with the selected model |
| First live repair attempt | Stopped at the configured estimated token budget after about 72 seconds; independent tests 25 passed / 2 failed |
| Explicit continuation in the same session | Stopped at the token budget after about 38 seconds; independent tests 27 passed / 0 failed |
| Protected oracle | Unchanged in both attempts |
| Agent completion / independent-check receipt for those two attempts | **Not achieved**; no final agent completion or receipt was recorded |

The continuation used real model/tool actions; no manual patch or reference
patch was applied. Two token-budget stops are a real limitation even though
the later external tests pass. The guide does not promise unattended success.

## Installation and documentation checks

The copy/paste installation block for macOS ARM64 was executed unchanged in a
fresh directory: public GitHub download, matching archive checksum, extraction,
real TUI Ready state and exit 0, in about **37 seconds**. It used an isolated
profile and made no inference request. Repeating the block from the original
parent refused the existing directory before overwriting files. All four Unix
installation blocks passed `sh -n`; their archive/folder names and the Windows
ZIP name match the published release assets. The new PowerShell download block
was reviewed but not executed in this macOS check; the native Windows binary
qualification above remains separate.

The bundled helper prefers the adjacent executable over the source launcher;
regression tests cover that selection, symlink refusal, pinned source integrity,
refusal to overwrite trials and modified-oracle detection. Extraction/startup
and the bundled baseline passed from an extracted macOS archive with neither Bun
nor pnpm on PATH. All five archives passed checksum and configured-key absence
checks; dependency notices were retained. Final executables passed the four
macOS/Linux startup checks above. Windows additionally passed five native ACL
tests and reproduced the bundled 22/27 baseline using Node/Git without package
installation.

The preparation workspace's suite recorded **1,904 passed, 14 skipped and zero
failed**. After the final Windows-only ACL helper changes, typechecks and the
focused runtime/session tests passed (**36 passed, one Windows-only skip** on
macOS); native Windows ACL checks covered that skipped case separately.
Eight compiled macOS coding/recovery fixtures passed with the real local
sandbox and fixture model responses; these are not live-provider benchmarks.

Binary-string secret scanning reported 13 reviewed false positives: generated
schema/Babel fields, a public crypto algorithm identifier and runtime diagnostic
labels. No unresolved finding or configured key was found. Pattern scans are
not exhaustive proof of secret absence. Final source export integrity, source
scanning and public download URLs are checked separately before publication.

The repository, historical bug and official Nebius links returned HTTP 200.
The Devpost homepage returned HTTP 403 to this automated check; its current
content was not reverified by that request.

A five-minute start is a target with prerequisites/key ready, not a cold-download
guarantee. One historical task is not a general success benchmark. No shared
public key, free judge-access arrangement or published Devpost project entry is
implied. The official hackathon and Nebius links were checked separately from
provider inference.
