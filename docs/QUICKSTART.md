# PHINs Agent — Quick Start

**An AI coding agent for your terminal.** PHINs Agent can inspect a repository, investigate failing tests, make code changes, and verify the result. This hackathon build uses **NVIDIA Nemotron 3 Super through Nebius Token Factory**.

**[Watch the demo](https://www.youtube.com/watch?v=zNPvf9Mw8LQ)** · **[Download v0.1.2](https://github.com/phins-group/phins-agent-cli/releases/tag/v0.1.2)** · **[Source code](https://github.com/phins-group/phins-agent-cli)**

> **Before you start:** You need a [Nebius Token Factory](https://tokenfactory.nebius.com/) API key, access to `nvidia/nemotron-3-super-120b-a12b`, and available inference credits. The standalone app does **not** require Docker, npm, or a local GPU. To run the coding demo, you also need **Node.js 22+** and **Git**. Setup takes approximately five minutes; agent tasks may take longer and consume credits.

## 1. Install and launch

Copy **one command** for your operating system. The installers detect the supported CPU, download release **v0.1.2**, verify its checksum, and open PHINs Agent. Review the installer source before running a remote script if required by your security policy.

### macOS — Apple Silicon (M1/M2/M3/M4) or Intel

Requires macOS 13+.

```sh
curl -fsSL https://raw.githubusercontent.com/phins-group/phins-agent-cli/main/install.sh | sh && "$HOME/.local/bin/phins"
```

### Linux — x64 or ARM64

Requires glibc 2.30+ (Alpine/musl is not supported).

```sh
curl -fsSL https://raw.githubusercontent.com/phins-group/phins-agent-cli/main/install.sh | sh && "$HOME/.local/bin/phins"
```

### Windows — x64

Requires Windows 10 (1809+) or Windows 11. Open **PowerShell in Windows Terminal**.

```powershell
irm https://raw.githubusercontent.com/phins-group/phins-agent-cli/main/install.ps1 | iex; if ($?) { & "$env:LOCALAPPDATA\PHINsAgent\bin\phins.cmd" }
```

**Expected result:** The terminal UI opens and shows **Ready**. Installation does not require administrator permissions. The installed release includes demo files and licensing notices.

**Open your own project later:**

macOS / Linux:

```sh
"$HOME/.local/bin/phins" "/path/to/your/project"
```

Windows PowerShell:

```powershell
& "$env:LOCALAPPDATA\PHINsAgent\bin\phins.cmd" "C:\path\to\your\project"
```

Use an existing project directory and replace the sample path. To open PHINs Agent without a project, omit the path argument.

**Prefer manual installation?** Download the complete archive for your platform from [GitHub Releases v0.1.2](https://github.com/phins-group/phins-agent-cli/releases/tag/v0.1.2), extract it, and run `./phins` (macOS/Linux) or `.\phins.exe` (Windows) from the extracted directory. Supported builds: macOS ARM64/x64, Linux ARM64/x64, Windows x64.

## 2. Connect Nebius Token Factory

1. Sign in to [Nebius Token Factory](https://tokenfactory.nebius.com/) and create an API key under **API keys** ([authentication guide](https://docs.tokenfactory.nebius.com/api-reference/introduction#authentication)).
2. In PHINs Agent, enter **`/setup`**.
3. Select **Nebius Token Factory**, enter your key, and choose **NVIDIA Nemotron 3 Super** (`nvidia/nemotron-3-super-120b-a12b`).
4. Confirm your selection. A completed model request—not a saved model list—confirms inference access.

Keep API keys private. Nebius inference consumes credits and may incur charges.

## 3. Run the coding demo

The release includes a reproducible example based on a historical [vercel/ms bug](https://github.com/vercel/ms/pull/111). The starting project intentionally fails **5 of 27 PHINs regression checks**. Do not install dependencies in the sample project.

**A. Open the demo directory**

Exit PHINs Agent using `/exit`, then run:

macOS / Linux (automatic installation):

```sh
cd "$(dirname "$(readlink "$HOME/.local/bin/phins")")"
```

Windows PowerShell (automatic installation):

```powershell
Set-Location "$env:LOCALAPPDATA\PHINsAgent\phins-0.1.2-local-windows-x64"
```

For a manual download, use the extracted release directory instead.

**B. Prepare and confirm the bug**

```sh
node scripts/demo.mjs prepare
node scripts/demo.mjs test
```

Expected baseline: **22 passed, 5 failed**. Exit code `1` is expected at this stage.

**C. Start the agent on the sample project**

macOS (recommended; uses an isolated demo profile):

```sh
node scripts/demo.mjs setup
node scripts/demo.mjs tui
```

This profile has separate credentials; enter your Nebius key again if prompted.

Linux:

```sh
./phins .local/demo-ms-pr111/project
```

Windows PowerShell:

```powershell
.\phins.exe .local\demo-ms-pr111\project
```

Open **`.local/demo-ms-pr111/task.txt`**, copy its task into the TUI, and press **Enter**. The agent should investigate the failure, propose a correction, edit `index.js`, and run tests. Review requested permissions; do not modify the regression tests.

## 4. Verify the result

After the agent finishes, enter `/exit`. From the same demo directory, run:

```sh
node scripts/demo.mjs test
git diff --no-index examples/live/ms-pr111/index.js .local/demo-ms-pr111/project/index.js
```

**Success criteria:** **27 passed, 0 failed**, test exit code `0`, and an inspectable source change. `git diff --no-index` typically returns `1` when files differ; that is not a test failure.

These are PHINs regression checks, **not** the upstream project's complete test suite. Model behavior varies, so a successful run is not guaranteed. Verify the tests independently rather than relying on the agent's final message.

## Troubleshooting

| Issue | What to check |
| --- | --- |
| API key rejected (`401`/`403`) | Reopen `/setup`; check Nebius key and account permissions. The macOS demo has a separate profile. |
| Model unavailable or request fails | Check model access, credits, network connectivity, and rate limits. |
| Installer or app fails | Confirm supported OS/CPU and checksum prerequisites; use the complete archive if installing manually. On macOS, review **Privacy & Security** if the system blocks a trusted build. |
| Installer reports an existing command or changed installation | It preserves older or modified installs. Use a fresh manual download instead of overwriting the existing command. |
| Demo cannot run | Confirm `node --version` reports **22+**, Git is installed, and commands run inside the release directory. |
| Agent stops early | Check run budget, credits, tool permissions, and the independent test results. |

## Uninstall

Close all PHINs Agent sessions first. Choose one removal mode below. For an
automatic installation:

macOS / Linux:

```sh
"$HOME/.local/bin/phins" uninstall
```

Windows PowerShell:

```powershell
& "$env:LOCALAPPDATA\PHINsAgent\bin\phins.cmd" uninstall
```

This removes this release's unchanged files and keeps your profile. To also
remove the **default profile** after reviewing the app, use:

macOS / Linux:

```sh
"$HOME/.local/bin/phins" uninstall --all
```

Windows PowerShell:

```powershell
& "$env:LOCALAPPDATA\PHINsAgent\bin\phins.cmd" uninstall --all
```

Both modes show the affected paths and require confirmation; **Enter cancels**.
`--all` permanently deletes keys, configuration, sessions, cache and logs under
`~/.phins-agent-cli` (Windows: `%USERPROFILE%\.phins-agent-cli`). Custom or linked
profiles are refused and preserved. The macOS demo's separate profile, files you
added or modified in the release, and external projects are retained.

For a manual download, run `./phins uninstall` (macOS/Linux) or
`.\phins.cmd uninstall` (Windows) from the extracted folder; add `--all` to delete
the default profile. Uninstall requires **v0.1.2** and its release inventory;
loose binaries and source checkouts are preserved.

---

**References:** [Demo video](https://www.youtube.com/watch?v=zNPvf9Mw8LQ) · [Release v0.1.2](https://github.com/phins-group/phins-agent-cli/releases/tag/v0.1.2) · [Source](https://github.com/phins-group/phins-agent-cli) · [Validation notes](QUICKSTART_VALIDATION.md) · [Nebius documentation](https://docs.tokenfactory.nebius.com/quickstart)
