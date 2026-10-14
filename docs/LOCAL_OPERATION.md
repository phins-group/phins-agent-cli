# Local operation

Use `pnpm cli setup` for masked key/model setup, `pnpm tui <project>` for the TUI
and `pnpm cli ask "request" --project <project>` for a single request.
`pnpm cli --help` lists commands. `/setup` and `/models` work in the TUI.

The source launcher stores state in `.local/home`. The standalone `phins` binary
opens the TUI by default and stores its separate profile in `~/.phins-agent-cli`.
Both support `PHINS_LOCAL_HOME`. Keys are local database records, not encrypted
OS keychain entries. Existing explicit `PHINS_CONFIG`, `PHINS_CONFIG_DIR` and
test-profile overrides are preserved. See [standalone builds](BINARY_DISTRIBUTION.md).

## Configuration

Use `configs/nebius.example.json` for private configuration. Current fields are
`providers`, `agents`, `commands`, `permissions`, `attachments` and `snapshots`.
`skills` is an array of locations; sampling is under `request.body`.
Per-agent permissions are arrays of `{ "action": "edit", "resource": "*", "effect": "deny" }`.
The schema is `packages/engine/src/settings/config.ts`.

Invalid/unsupported configuration fails startup. There is no V1 migration or LSP;
use tests, compilers and linters. Custom agents use `.phins/agents/`, current
frontmatter and a prompt body. The provider example asks before writes/commands
and denies external-directory access. Review project plugins/MCP/tools first;
do not grant everything merely to finish a demonstration.

## Display

Nebius model refresh combines account-visible IDs and public metadata. Tokens/
Context reflect reported usage; context includes input, cache, output and
reasoning. Cost is an estimated session total, not a bill. Unknown metadata shows
a dash; tiny costs show `<0.0001`. Configured rates/limits take precedence.

Session titles derive locally from the first request without an extra model call.
Manual titles persist. `/help` → Ctrl+T controls the English/Vietnamese brand line.

## Reviewed demo and limits

Follow [JUDGING_GUIDE.md](JUDGING_GUIDE.md). `pnpm demo:setup` stores its key/profile
under `.local/demo-ms-pr111/state`, separate from ordinary setup. The demo ignores project config,
requires a native macOS sandbox, protects its oracle and limits commands/correction.
Final snapshot tests cannot require network or writes; install dependencies first.
State isolation alone is not OS containment. CPU/memory/process-count quotas and
other platforms remain unqualified.

## Optional cumulative spending guard

Setup does not create a USD allowance. Create a reviewed private policy with
`limitUSD`, `priorUSD`, `endpoint`, `model`, `inputPerMillion`, `outputPerMillion`,
`maxOutputTokens` and `maxRequestBytes`. Verify prices and retain prior charges.

```sh
bun scripts/spending.ts init /absolute/private/budget.db /absolute/private/policy.json
bun scripts/spending.ts status /absolute/private/budget.db
```

Launch with `PHINS_SPENDING_LEDGER` pointing to the ledger. Initialization refuses
an existing ledger. The guard reserves each attempt and retains uncertain charges
across restarts. It supports pinned text-only HTTP with an output cap; unknown
prices or changed endpoint/model fail closed. It does not override service billing.

## Troubleshooting

- Missing key/model: run setup and verify account availability; never paste keys
  into issues or recordings.
- Existing demo: preparation refuses overwrite. Use another source extraction
  for a fresh trial; preserve previous evidence.
- Failed initial tests: expected before repairing the historical input.
- Unsupported snapshot/sandbox: use the qualified Mac environment.
- Failed/stopped task: inspect tools and report the failure rather than claiming
  success from the final message.
