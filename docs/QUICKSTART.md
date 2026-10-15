# PHINs Agent — Quick Start

**Try a real AI coding agent in your terminal.** In this demo, PHINs Agent investigates a bug, edits code, and runs tests using **NVIDIA Nemotron 3 Super via Nebius Token Factory**.

**Start here:** [Watch the 2-minute demo](https://www.youtube.com/watch?v=zNPvf9Mw8LQ) · [Download v0.1.1](https://github.com/phins-group/phins-agent-cli/releases/tag/v0.1.1) · [Source code](https://github.com/phins-group/phins-agent-cli)

> **Before you begin:** You need a [Nebius Token Factory](https://tokenfactory.nebius.com/) API key with access to `nvidia/nemotron-3-super-120b-a12b` and available inference credits. The agent runs without Docker, a local GPU, or npm installation. **The coding demo requires Node.js 22+ and Git.** Allow roughly 5 minutes for setup; agent execution may take longer and consume credits.

## 1. Install and launch

### Automatic installer — macOS and Linux

Paste this **one command** into a terminal. `install.sh` detects your OS and CPU,
selects the reviewed v0.1.1 binary, and verifies SHA-256 checksums. The command
then opens the TUI with your terminal's keyboard input:

```sh
curl -fsSL https://raw.githubusercontent.com/phins-group/phins-agent-cli/main/install.sh | sh && "$HOME/.local/bin/phins"
```

Supports macOS 13+ (Apple Silicon or Intel) and Linux ARM64/x64 with glibc 2.30+
(not Alpine/musl). Requires `curl`, `tar`, and `sha256sum` or `shasum`; these are
normally included on the supported desktop systems. No sudo or package manager
is used. The whole release, including demo files and licenses, is retained.

### Windows — automatic x64 installer

Open **PowerShell in Windows Terminal** on Windows 10 (1809+) or Windows 11:

```powershell
irm https://raw.githubusercontent.com/phins-group/phins-agent-cli/main/install.ps1 | iex; if ($?) { & "$env:LOCALAPPDATA\PHINsAgent\bin\phins.cmd" }
```

The installer checks Windows/CPU compatibility and verifies checksums. The
command then opens the TUI. Windows ARM64 and x86 are unsupported. PowerShell does not include `sh`;
use this native command there. `install.sh` also detects Git Bash/MSYS/Cygwin
and delegates Windows installation to PowerShell.

**Expected:** The PHINs Agent interface appears with a **Ready** status. Use a
real terminal for the interactive interface. Each installer only installs and
prints paths; the final part of the copied command starts PHINs Agent after a
successful installation. Repeating the installer reuses the verified build;
an unrelated existing command or changed installation is preserved and reported.

To reopen PHINs Agent later:

```sh
"$HOME/.local/bin/phins"                         # macOS / Linux
```

```powershell
& "$env:LOCALAPPDATA\PHINsAgent\bin\phins.cmd"    # Windows PowerShell
```

Pass an existing trusted project directory as an argument to open that project.
The installer prints the full installation and demo-folder paths.

### Direct downloads — optional manual installation

| OS | Download | Requirements |
| --- | --- | --- |
| **macOS — Apple Silicon** | [ARM64 archive](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.1/phins-0.1.1-local-darwin-arm64.tar.gz) | macOS 13+ |
| **macOS — Intel** | [x64 archive](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.1/phins-0.1.1-local-darwin-x64.tar.gz) | macOS 13+ |
| **Linux** | [x64 archive](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.1/phins-0.1.1-local-linux-x64.tar.gz) · [ARM64 archive](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.1/phins-0.1.1-local-linux-arm64.tar.gz) | glibc 2.30+, libstdc++ and libgcc |
| **Windows** | [x64 ZIP](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.1/phins-0.1.1-local-windows-x64.zip) | Windows 10 1809+ / Windows 11; Windows Terminal |

Extract the **whole** archive into a fresh directory and open a terminal in the
extracted folder. Run `./phins` on macOS/Linux or `.\phins.exe` in Windows
PowerShell. Manual downloads do not run the installer.

## 2. Connect Nebius

In PHINs Agent:

1. Enter `/setup`.
2. Choose **Nebius Token Factory** and enter your API key when prompted.
3. Select **NVIDIA Nemotron 3 Super** (`nvidia/nemotron-3-super-120b-a12b`).
4. Confirm the selection. A successful **real task response** verifies inference access; a saved model list alone does not.

To get an API key, sign in to [Nebius Token Factory](https://tokenfactory.nebius.com/), open **API keys**, and create a key. See the [official authentication guide](https://docs.tokenfactory.nebius.com/api-reference/introduction#authentication). Keep your key private; inference requires available credits and may incur charges.

## 3. Try the coding demo

The release includes a sample based on a historical [vercel/ms bug](https://github.com/vercel/ms/pull/111) and **27 PHINs regression checks**. Do **not** install packages inside the sample project.

First, enter `/exit` to return to your terminal. Make sure Node.js **22+** and
Git are installed. If you used the automatic installer, enter its demo folder:

**macOS / Linux:**

```sh
cd "$(dirname "$(readlink "$HOME/.local/bin/phins")")"
```

**Windows PowerShell:**

```powershell
Set-Location "$env:LOCALAPPDATA\PHINsAgent\phins-0.1.1-local-windows-x64"
```

For manual downloads, stay in the extracted release directory. Run all remaining
commands from this folder.

**Prepare and confirm the failing tests:**

```bash
node scripts/demo.mjs prepare
node scripts/demo.mjs test
```

**Expected starting point: `22 passed, 5 failed` (exit code 1).** These failures are intentional.

**Launch the demo:**

- **macOS (recommended, isolated demo profile):**

  ```bash
  node scripts/demo.mjs setup
  node scripts/demo.mjs tui
  ```

  Enter your Nebius key and select Nemotron again if prompted; this demo uses a separate profile.

- **Linux:** `./phins .local/demo-ms-pr111/project`
- **Windows PowerShell:** `.\phins.exe .local\demo-ms-pr111\project`

Open **`.local/demo-ms-pr111/task.txt`**, copy the task text, paste it into PHINs Agent, and press **Enter**. Observe the agent inspect the repository, propose a fix, edit `index.js`, and run tests. On Linux/Windows, review each requested permission; keep the tests unchanged.

## 4. Verify the result yourself

When the agent finishes, enter `/exit`. From the extracted release directory, run:

```bash
node scripts/demo.mjs test
```

**Successful outcome:** `27 passed, 0 failed` with exit code 0. To inspect the change:

```bash
git diff --no-index examples/live/ms-pr111/index.js .local/demo-ms-pr111/project/index.js
```

The diff command normally returns exit code **1** when it finds differences. These are PHINs regression tests, not the upstream full test suite. **Results are not guaranteed:** model behavior, permissions, network availability, and run budgets can affect completion. Treat the independent test result—not the agent's final message—as proof.

## Need help?

| Problem | Try this |
|---|---|
| Missing key or HTTP 401/403 | Run `/setup` again and check your Nebius account permissions. The macOS demo has its own profile. |
| Model unavailable / refresh error | Check model access, network, credits, and rate limits. A cached model list does not confirm connectivity. |
| Installer stops | Check OS/CPU support and the reported tool/checksum error. Existing unrelated commands or modified installs are preserved; use a fresh manual download if needed. |
| App won't launch | Check your OS/CPU build and extract the **whole** archive. On macOS/Linux, use `chmod +x ./phins` if needed. On macOS, approve a trusted app via **Privacy & Security** if prompted. |
| Demo setup fails | Install Node.js 22+ and Git; retry in a **new** extracted folder if a previous demo already exists. |
| Agent stops before success | Check remaining budget/credits and actual test results. A partial run is not a completed repair. |

**More information:** [Video demo](https://www.youtube.com/watch?v=zNPvf9Mw8LQ) · [Full validation notes](QUICKSTART_VALIDATION.md) · [GitHub releases](https://github.com/phins-group/phins-agent-cli/releases/tag/v0.1.1) · [Nebius documentation](https://docs.tokenfactory.nebius.com/quickstart)
