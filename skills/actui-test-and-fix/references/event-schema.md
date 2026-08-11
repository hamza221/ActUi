# ActUI event schema

## Run

```json
{
  "id": "uuid",
  "cursor": 15,
  "event": "pull_request",
  "status": "queued|blocked|running|success|failure|cancelled|skipped",
  "workflowIds": ["ci.yml"],
  "initiator": { "type": "human|agent", "name": "Codex" },
  "agent": {
    "connected": true,
    "phase": "testing|inspecting|fixing|waiting",
    "attempt": 1,
    "maxAttempts": 3,
    "filesChanged": [],
    "notes": []
  }
}
```

## Cursor change

`GET /api/runs/{id}/changes?after={cursor}&timeout={milliseconds}` returns at most the changes retained after the supplied cursor. Waiting is bounded to 30 seconds.

```json
{
  "cursor": 16,
  "type": "run.started|logs.available|agent.note|run.success|run.failure|run.cancelled",
  "time": "ISO-8601",
  "runId": "uuid",
  "status": "running",
  "jobs": [{ "workflowId": "ci.yml", "jobId": "test", "status": "running" }]
}
```

Consecutive log events are compacted into `logs.available` with a bounded
`logRange` object: `{ "from": 10, "to": 24, "count": 15 }`. Fetch only that
range with `read_logs` when its contents are relevant.

Persist the largest returned cursor and supply it as `after` on the next wait. An empty `changes` array means the bounded wait elapsed, not that the run disappeared.

## Failure result

```json
{
  "runId": "uuid",
  "status": "failure",
  "cursor": 31,
  "failures": [{
    "workflow": "ci.yml",
    "job": "test",
    "step": "unit tests",
    "exitCode": 1,
    "summary": "src/cart.test.ts:42: expected 2, received 3",
    "annotation": { "file": "src/cart.test.ts", "line": 42 },
    "logRange": { "from": 203, "to": 237 }
  }]
}
```

Call `read_logs` with the provided range. Log IDs are run-local, monotonically increasing, and independently addressable from the event cursor.
