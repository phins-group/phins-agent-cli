# PHINs Agent — Quick Start

**From Ideas to Impact.** PHINs Agent is a terminal-native AI coding agent that can inspect code, investigate failures, make approved changes, and run tests. This hackathon demo uses **NVIDIA Nemotron 3 Super via Nebius Token Factory**.

[Watch the demo](https://www.youtube.com/watch?v=zNPvf9Mw8LQ) · [Download v0.1.2](https://github.com/phins-group/phins-agent-cli/releases/tag/v0.1.2) · [Source code](https://github.com/phins-group/phins-agent-cli)

> **Before you start:** You need a [Nebius Token Factory](https://tokenfactory.nebius.com/) API key, access to the Nemotron model, and available inference credits. Running the agent requires no Docker, npm installation, or local GPU. The **sample coding demo** additionally requires **Node.js 22+ and Git**. Setup takes around five minutes; model execution may take longer and incur charges.

## 1. Install and launch

Copy **one command** for your operating system. The installer selects the appropriate v0.1.2 build, checks its SHA-256 checksum, and starts the TUI. You can [review the installer source](https://github.com/phins-group/phins-agent-cli) before running it.

### macOS — Apple Silicon (M1/M2/M3/M4) or Intel

macOS 13+:

```sh
curl -fsSL https://raw.githubusercontent.com/phins-group/phins-agent-cli/main/install.sh | sh && "$HOME/.local/bin/phins"
```

### Linux — x64 or ARM64

Requires glibc 2.30+; Alpine/musl is not supported.

```sh
curl -fsSL https://raw.githubusercontent.com/phins-group/phins-agent-cli/main/install.sh | sh && "$HOME/.local/bin/phins"
```

### Windows — x64

Windows 10 (1809+) or Windows 11. Use **Windows PowerShell 5.1** (included with
Windows) or **PowerShell 7** in Windows Terminal:

The installer checks for a 64-bit OS and verifies that the x64 executable runs.
Windows ARM64 TUI emulation is not qualified; see the [validation notes](QUICKSTART_VALIDATION.md).

```powershell
irm https://raw.githubusercontent.com/phins-group/phins-agent-cli/main/install.ps1 | iex; if ($?) { & "$env:LOCALAPPDATA\PHINsAgent\bin\phins.cmd" }
```

**You should see:** PHINs Agent open with a **Ready** status. The installation does not require administrator privileges.

**Open an existing project later:**

macOS / Linux:

```sh
"$HOME/.local/bin/phins" "/path/to/your/project"
```

Windows PowerShell:

```powershell
& "$env:LOCALAPPDATA\PHINsAgent\bin\phins.cmd" "C:\path\to\your\project"
```

Replace the example with an existing project folder. Omit the path to start without specifying a project. Prefer a [manual download](https://github.com/phins-group/phins-agent-cli/releases/tag/v0.1.2)? Extract the full archive and run `./phins` (macOS/Linux) or `.\phins.exe` (Windows) from its folder.

## 2. Connect Nebius

1. [Sign in to Nebius Token Factory](https://tokenfactory.nebius.com/) and create an API key under **API keys** ([official instructions](https://docs.tokenfactory.nebius.com/api-reference/introduction#authentication)).
2. In PHINs Agent, type **`/setup`**.
3. Select **Nebius Token Factory**, enter the API key, and select **NVIDIA Nemotron 3 Super** (`nvidia/nemotron-3-super-120b-a12b`).
4. Submit a task to confirm inference works. Saving a model selection alone does not verify access.

**Keep your API key private.** Inference requires available credits and may incur charges.

## 3. Try the coding demo

The release includes a reproducible example based on a historical [vercel/ms bug](https://github.com/vercel/ms/pull/111). Its **27 PHINs regression checks** initially contain five failures. Do not install dependencies in this example.

**A. Open the demo folder.** Type `/exit` in the TUI, then run:

macOS / Linux (automatic installation):

```sh
cd "$(dirname "$(readlink "$HOME/.local/bin/phins")")"
```

Windows PowerShell (automatic installation):

```powershell
Set-Location "$env:LOCALAPPDATA\PHINsAgent\phins-0.1.2-local-windows-x64"
```

For manual installation, use the extracted release folder.

**B. Prepare the sample and reproduce the bug:**

```sh
node scripts/demo.mjs prepare
node scripts/demo.mjs test
```

Expected baseline: **22 passed, 5 failed**. A non-zero test exit code is expected here.

**C. Start the demo agent:**

macOS (isolated demo profile):

```sh
node scripts/demo.mjs setup
node scripts/demo.mjs tui
```

The isolated profile may request your Nebius key again.

Linux:

```sh
./phins .local/demo-ms-pr111/project
```

Windows PowerShell:

```powershell
.\phins.exe .local\demo-ms-pr111\project
```

Open **`.local/demo-ms-pr111/task.txt`**, copy the task into the TUI, and press **Enter**. Observe the agent investigate the bug, propose changes, edit `index.js`, and run tests. Approve only appropriate tool actions; leave the regression tests unchanged.

## 4. Verify the result

After the agent finishes, enter `/exit`. In the demo folder, run:

```sh
node scripts/demo.mjs test
git diff --no-index examples/live/ms-pr111/index.js .local/demo-ms-pr111/project/index.js
```

**Success:** **27 passed, 0 failed**, test exit code `0`, and a reviewable source change. The diff command may return `1` because files differ; that is normal. These are PHINs regression checks, not the upstream complete test suite. Model behavior can vary—rely on the independent test results, not solely on the agent's summary.

## Troubleshooting

| Issue | What to do |
| --- | --- |
| API key rejected (401/403) | Reopen `/setup`; verify your key and Nebius access. The macOS demo has a separate profile. |
| Model request fails | Check model access, remaining credits, connectivity, and rate limits. |
| App does not start | Confirm your OS/CPU is supported. For manual installation, extract the full archive. On macOS, review **Privacy & Security** if prompted. |
| Demo does not run | Check `node --version` (22+), Git, and your current release folder. |
| Agent stops early | Review permissions, run budget, credits, and independent test results. |

## Uninstall completely

Close PHINs Agent, then run **`uninstall --all`** for your operating system.

macOS / Linux:

```sh
"$HOME/.local/bin/phins" uninstall --all
```

Windows PowerShell:

```powershell
& "$env:LOCALAPPDATA\PHINsAgent\bin\phins.cmd" uninstall --all
```

**Warning:** After confirmation, `--all` removes the managed release and default PHINs Agent profile, including saved API keys, configuration, sessions, cache, and logs. External projects and certain custom or modified files are preserved; see the removal summary before confirming.

---

[Demo video](https://www.youtube.com/watch?v=zNPvf9Mw8LQ) · [GitHub Release](https://github.com/phins-group/phins-agent-cli/releases/tag/v0.1.2) · [Validation notes](QUICKSTART_VALIDATION.md) · [Nebius documentation](https://docs.tokenfactory.nebius.com/quickstart)
