# ActUI local protocol

ActUI exposes one loopback HTTP control plane to the dashboard, JSON CLI, and MCP adapter. Every request requires the random session token created when the dashboard launches.

## Resources

- `GET /api/health` — repository, trust, Act, Docker, and dashboard metadata.
- `GET /api/workflows` — parsed workflow, trigger, job, step, matrix, and risk metadata.
- `POST /api/runs` — start one shared run.
- `GET /api/runs/{id}` — retrieve the current run snapshot.
- `GET /api/runs/{id}/events` — browser-oriented SSE snapshots.
- `GET /api/runs/{id}/changes?after=N&timeout=25000` — bounded cursor changes.
- `GET /api/runs/{id}/failed` — concise failure results with annotations and log ranges.
- `GET /api/runs/{id}/logs?from=N&to=N&limit=N&failed=true` — bounded log access.
- `POST /api/runs/{id}/notes` — add an agent phase/note/files-changed update.
- `POST /api/runs/{id}/cancel` — cancel the shared Act process.
- `POST /api/runs/{id}/rerun-failed` — rerun the smallest failed scope under the attempt limit.

## Cursor semantics

Each material run change increments a run-local integer cursor. A client retains the greatest observed cursor and provides it as `after` on the next wait. Changes are ordered and retained in a bounded ring. Consecutive log events are compacted into one `logs.available` change with a `{from,to,count}` log range. A bounded wait briefly coalesces live log bursts, returns early for state changes, and returns an empty `changes` array on timeout.

Log IDs are independent run-local integers. Failure results include the relevant log range, allowing agents to avoid reading unrelated output.

## Statuses

Runs and jobs use `queued`, `blocked`, `running`, `success`, `failure`, `cancelled`, and `skipped`. `blocked` is an ActUI presentation state for work waiting on job dependencies or concurrency capacity.

## Failure shape

Each failure contains `workflow`, `job`, optional `step`, `exitCode`, `summary`, optional `{file,line,column}` annotation, and optional `{from,to}` log range. The response also carries the latest event cursor.

## Compatibility

The protocol is provider-neutral JSON over local HTTP. The MCP server and CLI are adapters, not separate schedulers. Clients should ignore unknown object fields and event types for forward compatibility.
