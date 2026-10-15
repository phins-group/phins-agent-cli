# PHINs Agent — Quick Start

**Try a real AI coding agent in your terminal.** In this demo, PHINs Agent investigates a bug, edits code, and runs tests using **NVIDIA Nemotron 3 Super via Nebius Token Factory**.

**Start here:** [Watch the 2-minute demo](https://www.youtube.com/watch?v=zNPvf9Mw8LQ) · [Download v0.1.1](https://github.com/phins-group/phins-agent-cli/releases/tag/v0.1.1) · [Source code](https://github.com/phins-group/phins-agent-cli)

> **Before you begin:** You need a [Nebius Token Factory](https://tokenfactory.nebius.com/) API key with access to `nvidia/nemotron-3-super-120b-a12b` and available inference credits. The agent runs without Docker, a local GPU, or npm installation. **The coding demo requires Node.js 22+ and Git.** Allow roughly 5 minutes for setup; agent execution may take longer and consume credits.

## 1. Download and launch

Choose **one** option for your machine. Use a fresh directory. The commands download, extract, and launch PHINs Agent. By default, the agent opens normally; to work on your own repository, use the project-path command shown in the same section (replace the example with an existing trusted folder).

### macOS — Apple Silicon (M1/M2/M3/M4)

Requires macOS 13+.

```bash
mkdir phins-agent-preview && cd phins-agent-preview
curl -fL -O https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.1/phins-0.1.1-local-darwin-arm64.tar.gz
tar -xzf phins-0.1.1-local-darwin-arm64.tar.gz
cd phins-0.1.1-local-darwin-arm64
./phins
# Or open your own project instead:
# ./phins "/path/to/your/reviewed/project"
```

### macOS — Intel

```bash
mkdir phins-agent-preview && cd phins-agent-preview
curl -fL -O https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.1/phins-0.1.1-local-darwin-x64.tar.gz
tar -xzf phins-0.1.1-local-darwin-x64.tar.gz
cd phins-0.1.1-local-darwin-x64
./phins
# Or open your own project instead:
# ./phins "/path/to/your/reviewed/project"
```

### Linux — x64

Requires glibc 2.30+ (not Alpine/musl).

```bash
mkdir phins-agent-preview && cd phins-agent-preview
curl -fL -O https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.1/phins-0.1.1-local-linux-x64.tar.gz
tar -xzf phins-0.1.1-local-linux-x64.tar.gz
cd phins-0.1.1-local-linux-x64
./phins
# Or open your own project instead:
# ./phins "/path/to/your/reviewed/project"
```

Linux ARM64: [download the ARM64 archive](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.1/phins-0.1.1-local-linux-arm64.tar.gz), extract it, enter `phins-0.1.1-local-linux-arm64`, and run `./phins` (or `./phins "/path/to/your/reviewed/project"` to open a project).

### Windows — x64

Requires Windows 10 (1809+) or Windows 11. Open **PowerShell in Windows Terminal**.

```powershell
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Path phins-agent-preview | Out-Null
Set-Location phins-agent-preview
Invoke-WebRequest -Uri https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.1/phins-0.1.1-local-windows-x64.zip -OutFile phins.zip
Expand-Archive -LiteralPath phins.zip -DestinationPath .
Set-Location phins-0.1.1-local-windows-x64
.\phins.exe
# Or open your own project instead:
# .\phins.exe "C:\path\to\your\reviewed\project"
```

**Expected:** The PHINs Agent terminal interface appears with a **Ready** status.

The project-path command in each OS section is an **alternative** to the default launch, not an additional step. Remove the leading `#` to run it. Use quotation marks for paths containing spaces. For the prepared hackathon sample, follow **Step 3** instead.

## 2. Connect Nebius

In PHINs Agent:

1. Enter `/setup`.
2. Choose **Nebius Token Factory** and enter your API key when prompted.
3. Select **NVIDIA Nemotron 3 Super** (`nvidia/nemotron-3-super-120b-a12b`).
4. Confirm the selection. A successful **real task response** verifies inference access; a saved model list alone does not.

To get an API key, sign in to [Nebius Token Factory](https://tokenfactory.nebius.com/), open **API keys**, and create a key. See the [official authentication guide](https://docs.tokenfactory.nebius.com/api-reference/introduction#authentication). Keep your key private; inference requires available credits and may incur charges.

## 3. Try the coding demo

The release includes a sample based on a historical [vercel/ms bug](https://github.com/vercel/ms/pull/111) and **27 PHINs regression checks**. Do **not** install packages inside the sample project.

First, in PHINs Agent enter `/exit` to return to your terminal. You should remain in the extracted release directory. Make sure Node.js **22+** and Git are installed.

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
| App won't launch | Check your OS/CPU build and extract the **whole** archive. On macOS/Linux, use `chmod +x ./phins` if needed. On macOS, approve a trusted app via **Privacy & Security** if prompted. |
| Demo setup fails | Install Node.js 22+ and Git; retry in a **new** extracted folder if a previous demo already exists. |
| Agent stops before success | Check remaining budget/credits and actual test results. A partial run is not a completed repair. |

**More information:** [Video demo](https://www.youtube.com/watch?v=zNPvf9Mw8LQ) · [Full validation notes](QUICKSTART_VALIDATION.md) · [GitHub releases](https://github.com/phins-group/phins-agent-cli/releases/tag/v0.1.1) · [Nebius documentation](https://docs.tokenfactory.nebius.com/quickstart)
