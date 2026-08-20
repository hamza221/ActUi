---
name: actui-test-and-fix
description: Run focused local GitHub Actions test-and-fix loops through ActUI's shared dashboard, JSON CLI, or MCP server. Use when asked to test changes locally with Act, inspect a failing workflow, monitor CI with a human, fix an authorized failure, rerun only failed scope, or expose local CI progress to the user.
---

# ActUI test and fix

Use ActUI as the single source of truth for local CI state. Keep the human dashboard and agent operations attached to the same run ID.

## Required loop

1. Run `actui discover . --json` or call `discover_workflows`.
2. Select the smallest workflow and job relevant to the changed files. Do not start every workflow by default.
3. Confirm a trusted ActUI session exists. Never add `--approved` for a protected job unless the user explicitly authorized that deployment, publishing, privileged, release, or production-like action.
4. Start the run with an agent initiator and surface the returned dashboard URL to the user.
5. Retain the returned cursor. Use `wait_for_run` or `actui wait <run-id> --after-cursor <cursor> --json` for bounded waits.
6. On failure, call `get_failed_steps` first. Fetch only the referenced log ranges with `read_logs`; do not ingest the complete live log without a concrete need.
7. Diagnose the failure. Edit files only when the user authorized a fix. Do not reinterpret a request to test, observe, or diagnose as permission to change code.
8. Before retrying, add an agent note describing the diagnosis and changed files. Rerun only the failed job or workflow with `rerun_failed`.
9. Stop on success, a genuine blocker, loss of authorization, or the configured attempt limit. Never widen scope to bypass the attempt limit.

## Safety invariants

- Treat repository workflows as executable code. Require the trusted-repository gate.
- Give agent-started runs no secrets by default. Never request or infer credentials.
- Show the exact Act command preview before a protected run.
- Keep deployments, publishing, privileged containers, production environments, and equivalent side effects behind explicit approval.
- Preserve ActUI redaction and the shared audit trail.
- Cancel the shared run only when requested, when continued execution is unsafe, or when the current task has been superseded.
- Report source annotations and concise summaries before selected logs.

## Interfaces

Prefer MCP tools when configured. Otherwise use the JSON CLI. Do not start a second dashboard or runner when one session is active.

On macOS the shared session file is `~/Library/Caches/actui/session.json`; on Linux it is `${XDG_CACHE_HOME:-~/.cache}/actui/session.json`.

- Discovery: `discover_workflows` / `actui discover . --json`
- Start: `start_run` / `actui run --workflow <file> --event <event> --json`
- Wait: `wait_for_run` / `actui wait <id> --after-cursor <n> --json`
- Inspect: `get_failed_steps`, `read_logs` / `actui logs <id> --failed --json`
- Retry: `rerun_failed` / `actui rerun-failed <id> --files <paths> --json`
- Stop: `cancel_run` / `actui cancel <id> --json`

Read [references/event-schema.md](references/event-schema.md) when implementing a client, interpreting cursor changes, or selecting log ranges.
