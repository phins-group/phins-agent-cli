# PHINs Agent

<img src="packages/terminal/src/tui/assets/phins-logo.png" alt="PHINs Agent logo" width="480">

> FROM IDEAS to IMPACT

A local coding agent that turns a bug report into an inspectable patch and real
test results. CLI and TUI share one engine for inspection, planning, tools,
correction, verification and resumable sessions.

The hackathon integration uses **NVIDIA Nemotron on Nebius Token Factory**.
This source builds independently with two workspace packages and no private
backend. It includes modified third-party code; see [NOTICE](NOTICE).

## Quick Start — Try PHINs Agent

Download and extract a standalone binary. No Bun/pnpm or agent package
installation is needed.

| Operating system | Download |
| --- | --- |
| **macOS** | [Apple Silicon / ARM64](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.0/phins-0.1.0-local-darwin-arm64.tar.gz) · [Intel / x64](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.0/phins-0.1.0-local-darwin-x64.tar.gz) |
| **Linux** | [x64](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.0/phins-0.1.0-local-linux-x64.tar.gz) · [ARM64](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.0/phins-0.1.0-local-linux-arm64.tar.gz) |
| **Windows** | [Windows x64 ZIP](https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.0/phins-0.1.0-local-windows-x64.zip) |

Follow the [Quick Start guide](docs/QUICKSTART.md) for installation, Nebius
configuration and a reproducible coding-agent demo. It includes platform
requirements and qualification limits. The demo's tests need Node.js 22+ and Git.

## Run from source (developers)

Qualified platform: **macOS ARM64**. Install Node.js 22+, Bun 1.3.12+,
pnpm 10.26.0 and Git. Use a real terminal for the TUI.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm cli --help
pnpm cli setup
pnpm tui /absolute/path/to/your/reviewed/project
```

Setup prompts for a masked API key and model. Nebius setup recommends an
available NVIDIA Nemotron with tool support. Use `/setup` or `/models` in the TUI
to change it later. Setup makes no inference request; submitting a task does.
Keys stay in a local database, not an encrypted OS keychain.

TUI commands: `/models`, `/new`, `/sessions`, `/compact`, `/setup`, `/help`
and `/exit`. Code changes remain visible in tool results.

For a single CLI request:

```sh
pnpm cli ask "Inspect this repository and explain its test command" --project /absolute/path/to/project
```

Source launches isolate state under `.local/home`. Override with
`PHINS_LOCAL_HOME`. Keep credentials outside the task repository.

## Reproduce the historical bug demo

```sh
pnpm demo:prepare
pnpm demo:test
pnpm demo:setup
pnpm demo:tui
```

Preparation copies the pinned, attributed `vercel/ms` input and the 27-check
oracle into `.local/demo-ms-pr111/project`. It creates no Git commit or remote,
overwrites nothing and calls no model. The first test command **should fail**:
it demonstrates the original bug.

Demo setup uses its own isolated state under `.local/demo-ms-pr111/state`.
After that setup, open the demo TUI and paste `.local/demo-ms-pr111/task.txt`.
This is the paid inference step. The profile permits changes only to `index.js`,
allows one exact test command, protects the oracle and enables the macOS sandbox
and bounded correction workflow. It pins `nvidia/nemotron-3-super-120b-a12b`
on Nebius; account availability and credits are required.

After the agent finishes, run `pnpm demo:test` again and inspect the diff and
independent verification receipt. Final prose alone is not verification.
See [the judging guide](docs/JUDGING_GUIDE.md) for the full sequence.

## Capabilities and architecture

- Select relevant context rather than loading whole repositories by default.
- Plan work, read/search/edit files and execute approved commands.
- Use actual test failures for bounded correction.
- Keep sessions, tools, usage and estimated cost visible.
- In the reviewed profile, independently check a read-only snapshot.

```text
CLI / TUI → engine session → selected context → model request
                  ↑                                  ↓
           verification ← tests ← edits ← permitted tools
```

`packages/engine` owns workflows, providers, storage and authenticated local
transport. `packages/terminal` owns CLI and Solid/OpenTUI. TypeScript, Bun,
Effect and SQLite are the main runtime technologies. Nebius is optional outside
the competition. See [architecture](docs/ARCHITECTURE.md).

## Build and test

```sh
pnpm source:check
pnpm check
pnpm test
pnpm build
pnpm test:coding
```

The native build produces `dist/phins` (`dist/phins.exe` on Windows) without
fetching model metadata. `pnpm build:all` builds macOS ARM64/x64, Linux ARM64/x64
and Windows x64. `pnpm build:package <new-name>` creates local review archives.
The Mac binaries are ad-hoc signed, not notarized. Tests use local/scripted
providers; they do not prove real model decisions.
[Evaluation](docs/BENCHMARK.md) separates the evidence.

## Limits

The reviewed profile is qualified on macOS. Recorded Nebius/NVIDIA
trials passed the fixed historical oracle; one required a test-driven correction.
See [measured evidence](docs/BENCHMARK.md). Linux/Windows hardened workflows,
CPU/memory quotas and broad task success remain unqualified.
The independent final check needs tests that require neither network nor writes.

Normal setup does not create a USD allowance. Run limits and displayed costs
are not a provider billing cap. Review prices and credits before inference.
[Local operation](docs/LOCAL_OPERATION.md) covers configuration and spending.

## License

PHINs contributions: Copyright 2026 Duy Huynh, [Apache-2.0](LICENSE).
Inherited MIT portions retain their terms: [NOTICE](NOTICE),
[provenance](PROVENANCE.md), [third-party licenses](THIRD_PARTY.md).
`Apache-2.0 AND MIT` is not a choice of either license for all code.
No model weights are bundled. Branding does not grant general trademark rights.

[Submission copy](docs/SUBMISSION.md) and the [video script](docs/DEMO_SCRIPT.md)
remain drafts until current live evidence, judge access and video are finalized.
