# PHINs Agent — Quick Start

PHINs Agent is a terminal-native AI coding agent designed to turn developer intent into verifiable engineering outcomes.

Get running in approximately **5 minutes**, with an API key ready. Download
speed and model response time vary. **No Bun, pnpm, npm install, Docker or local
GPU is needed to launch the binary.**

## Prerequisites

- A supported system from the download table below and a real terminal.
  Use Windows Terminal on Windows; the included Windows PowerShell validates
  private runtime permissions.
- A **Nebius Token Factory API key**, access to NVIDIA Nemotron 3 Super, and
  available inference credits.
- Internet access to download the archive and contact Nebius.
- **For the coding demo only:** Node.js **22+** and Git on your PATH. These run
  the sample repository's tests; they are not agent installation dependencies.

## Installation

Download the archive for your operating system and processor:

| Operating system | Direct download | System requirements |
|---|---|---|
| **macOS** | [Apple Silicon / ARM64](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.0/phins-0.1.0-local-darwin-arm64.tar.gz) · [Intel / x64](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.0/phins-0.1.0-local-darwin-x64.tar.gz) | macOS 13+ |
| **Linux** | [x64](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.0/phins-0.1.0-local-linux-x64.tar.gz) · [ARM64](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.0/phins-0.1.0-local-linux-arm64.tar.gz) | glibc 2.30+, libstdc++ and libgcc; Alpine/musl unsupported |
| **Windows** | [Windows x64 ZIP](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.0/phins-0.1.0-local-windows-x64.zip) | Windows 10 1809+ / Windows 11, Windows Terminal; no Windows ARM64 build |

Extract the archive, keep its accompanying notices, and open a terminal in the
extracted folder. Optionally compare the archive against
[SHA256SUMS](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.0/SHA256SUMS).
This is the **0.1.0 hackathon preview**, whose executable reports `0.1.0-local`.
Platform qualification and limitations are in [the validation report](QUICKSTART_VALIDATION.md).

**macOS / Linux:**

```sh
./phins --version
```

**Windows PowerShell:**

```powershell
.\phins.exe --version
```

## Configure Nebius Token Factory

1. Sign in to [Nebius Token Factory](https://tokenfactory.nebius.com/), open
   **API keys → Create API key**, and save the key privately. See the
   [official instructions](https://docs.tokenfactory.nebius.com/api-reference/introduction#authentication).
   Never publish a test key or paste it into source, screenshots or issues.
2. Run masked setup from the extracted folder.

   **macOS / Linux:**

   ```sh
   ./phins setup
   ```

   **Windows PowerShell:**

   ```powershell
   .\phins.exe setup
   ```

3. Choose **Nebius Token Factory** if prompted, enter the key, and select
   **NVIDIA Nemotron 3 Super** with Enter. Exact model ID:
   **`nvidia/nemotron-3-super-120b-a12b`**. The preset uses
   **`https://api.tokenfactory.nebius.com/v1`**.
4. Confirm the saved model. Setup refreshes the account's model catalog without
   inference. **“API refresh failed” / “saved list” does not verify the
   connection**; correct the key/network first. A real task response verifies
   inference access.

No environment variables or JSON edits are required. The optional credential
variable is **`NEBIUS_API_KEY`**; masked setup is preferred. Keys are stored
locally beneath `~/.phins-agent-cli` (Windows: `%USERPROFILE%\.phins-agent-cli`),
not an encrypted OS keychain. Tasks consume credits; displayed costs and run
limits are not a provider billing cap.

## Launch PHINs Agent

**macOS / Linux:**

```sh
./phins
```

**Windows PowerShell:**

```powershell
.\phins.exe
```

Expect the welcome message, focused task input, **Ready** status, current
project path and selected Nebius/NVIDIA model. No task runs until you submit
one. In the TUI, use these commands individually to select a model, configure
credentials or exit:

```text
/models
/setup
/exit
```

## Try the Working Demo

The archive includes the MIT-licensed historical
[vercel/ms bug](https://github.com/vercel/ms/pull/111), pinned buggy source and
27 regression checks. **Do not install packages in the sample project.**
From the extracted archive folder:

```sh
node --version
git --version
node scripts/demo.mjs prepare
node scripts/demo.mjs test
```

The initial test should **exit 1: 22 passed, 5 failed, 27 total**. This is the
bug, not an installation failure. Preparation creates
`.local/demo-ms-pr111/project` and refuses to overwrite an earlier trial.

**Recommended judging path — macOS:**

```sh
node scripts/demo.mjs setup
node scripts/demo.mjs tui
```

This runs the adjacent binary with an isolated demo profile. Enter your key
once for this separate profile and select the same Nemotron model. The profile
protects the tests, allows edits only to `index.js`, uses the macOS sandbox and
permits the exact regression command. No Bun/pnpm is invoked.

**Linux:** use your ordinary setup from above and open the prepared project:

```sh
./phins .local/demo-ms-pr111/project
```

**Windows PowerShell:**

```powershell
.\phins.exe .local\demo-ms-pr111\project
```

Linux/Windows use the ordinary permission prompts. Review requested actions;
allow changes to `index.js` and the relevant Node test command, and keep tests
unchanged. The hardened macOS profile and snapshot-check workflow are not
qualified on those systems.

Open `.local/demo-ms-pr111/task.txt` in a text editor, copy its request into the
TUI and press **Enter**. It asks the agent to inspect, plan, reproduce the bug,
fix parsing, run tests and correct failures. Watch actual tools and results.
After the agent stops, exit the TUI before independent verification.

## Expected Results

From the extracted archive folder:

```sh
node scripts/demo.mjs test
git diff --no-index examples/live/ms-pr111/index.js .local/demo-ms-pr111/project/index.js
```

Success means **27 passed, 0 failed, test exit 0**, with a reviewable source
patch. The test helper rejects a modified oracle. The diff exits **1 when
files differ**, which is expected. On the hardened Mac path, also inspect the
independent-check receipt; a final message alone is not proof.

These are PHINs regression checks, not the upstream full suite. Model behavior
varies and recorded successes do not guarantee your run. A budget stop is not
agent completion, even if a subsequent external test passes. See
[the validation report](QUICKSTART_VALIDATION.md) for observed outcomes.
Free judge credentials must be arranged privately; this guide never supplies
a shared public key.

## Troubleshooting

| Issue | What to do |
|---|---|
| Missing key / HTTP 401 or 403 | Reopen masked setup and check the key's project/access in Nebius. The hardened demo uses its own setup/profile. |
| Model missing / unsupported | Search the exact Nemotron model ID and confirm account availability. Do not silently substitute a different model for this demo. |
| Refresh failure, timeout or HTTP 429 | Check Nebius connectivity, credits and rate limits. Reopen the model picker to refresh; saved models are not proof of authentication. |
| macOS blocks the download | Verify its checksum and use macOS Privacy & Security to approve the trusted executable. Do not disable system security globally. |
| CLI does not start | Extract the complete archive, choose the correct OS/CPU and use a real terminal. On macOS/Linux, restore executable permission if your extractor removed it using the command below. |
| Windows exit shortcut | Use `/exit`. Ctrl+D returned exit 1 in the Windows console harness and is not qualified for this preview. |
| Demo dependency missing | Install Node.js 22+ / Git for repository testing; Bun/pnpm and sample packages are unnecessary. |
| Demo already exists | Extract into a new folder for a fresh trial; preserve previous evidence. |
| Agent stopped at token/time budget | Inspect tests and changes. A deliberate continuation in the same session is supported, consumes credits and may still stop. Use the session picker if reopening; do not claim completion without final evidence. |

**macOS / Linux, if executable permission was lost:**

```sh
chmod +x ./phins
```

## Useful Links

- [GitHub repository](https://github.com/phins-group/phins-agent-cli) and [0.1.0 downloads](https://github.com/phins-group/phins-agent-cli/releases/tag/v0.1.0)
- [Nebius Token Factory](https://tokenfactory.nebius.com/) and [official quickstart](https://docs.tokenfactory.nebius.com/quickstart)
- [Nebius × NVIDIA Global AI Hackathon](https://nebiusglobalaihackathon.devpost.com/) — project-specific Devpost URL not yet published.
- [Main documentation](../README.md), [platform/build details](BINARY_DISTRIBUTION.md), and [submission draft](SUBMISSION.md)
