import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RunManager, parseLog } from "../server/run-manager.mjs";

const fixture = fileURLToPath(new URL("fixtures/fake-act", import.meta.url));
const captureFixture = fileURLToPath(new URL("fixtures/fake-act-capture", import.meta.url));
const workflow = {
  id: "ci.yml",
  name: "CI",
  path: ".github/workflows/ci.yml",
  absolutePath: "/tmp/ci.yml",
  triggers: ["pull_request"],
  valid: true,
  jobs: [{ id: "test", name: "Test", needs: [], runner: "ubuntu-latest", steps: 1, requiresApproval: false }],
};

test("parses Act logfmt records without leaking the wrapper into the message", () => {
  const parsed = parseLog('time="2026-08-11T10:00:00Z" level=error msg="listen tcp 192.168.1.6:34567: bind: address already in use" jobID=php-cs step="PHP CS"');
  assert.equal(parsed.level, "error");
  assert.equal(parsed.message, "listen tcp 192.168.1.6:34567: bind: address already in use");
  assert.equal(parsed.fields.jobID, "php-cs");
  assert.equal(parsed.fields.step, "PHP CS");
});

test("labels step output and infers the failed step name from Act messages", () => {
  const manager = new RunManager({ repo: "/tmp", actPath: fixture, workflows: [workflow], trusted: true, storage: "/tmp/unused-actui-test" });
  const run = {
    id: "log-test",
    status: "running",
    cursor: 0,
    logs: [],
    jobs: [{ ...workflow.jobs[0], workflowId: workflow.id, status: "running" }],
  };
  manager.redactions.set(run.id, new Set());
  manager.appendLog(run, parseLog('{"jobID":"test","msg":"  | release check output"}'), workflow);
  manager.appendLog(run, parseLog('{"jobID":"test","step":"Check release PR","msg":"plain JSON-mode step output"}'), workflow);
  manager.appendLog(run, parseLog('{"jobID":"test","step":"Check release PR","msg":"  🐳  docker exec cmd=[node]"}'), workflow);
  manager.appendLog(run, parseLog('{"jobID":"test","level":"error","msg":"❌ Failure - Main Check release PR"}'), workflow);
  assert.equal(run.logs[0].stream, "step");
  assert.equal(run.logs[1].stream, "step");
  assert.equal(run.logs[2].stream, "act");
  assert.equal(run.logs[3].step, "Check release PR");
  assert.equal(manager.failedSteps(run.id), null);
  manager.runs.set(run.id, run);
  assert.equal(manager.failedSteps(run.id).failures[0].step, "Check release PR");
});

test("passes Docker context, repository slug, event payload, and trusted extra args to Act", async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), "actui-runs-"));
  await chmod(captureFixture, 0o755);
  try {
    const manager = new RunManager({
      repo: "/tmp",
      actPath: captureFixture,
      workflows: [workflow],
      trusted: true,
      storage,
      dockerHost: "unix:///Users/test/.orbstack/run/docker.sock",
      githubRepository: "owner/repository",
    });
    await manager.initialize();
    const started = await manager.create({
      event: "pull_request",
      workflowIds: ["ci.yml"],
      eventPayload: { pull_request: { number: 42 } },
      actArgs: ["--container-options", "--volume /tmp/stubs:/stubs"],
    });
    let snapshot = manager.get(started.id);
    for (let attempt = 0; attempt < 20 && ["queued", "running", "blocked"].includes(snapshot.status); attempt += 1) {
      await manager.waitForChanges(started.id, snapshot.cursor, 500);
      snapshot = manager.get(started.id);
    }
    const capture = snapshot.logs.map((entry) => entry.message).join("\n");
    assert.match(capture, /docker=unix:\/\/\/Users\/test\/\.orbstack\/run\/docker\.sock/);
    assert.match(capture, /--env GITHUB_REPOSITORY=owner\/repository/);
    assert.match(capture, /--container-options --volume \/tmp\/stubs:\/stubs/);
    assert.match(capture, /payload=\{"pull_request":\{"number":42\}\}/);
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test("preserves multiple custom runner mappings in the Act command", () => {
  const manager = new RunManager({ repo: "/tmp", actPath: fixture, workflows: [workflow], trusted: true, storage: "/tmp/unused-actui-test" });
  const command = manager.commandPreview([workflow], {
    event: "pull_request",
    platform: ["ubuntu-latest-low=catthehacker/ubuntu:act-latest", "gpu=-self-hosted"],
  });
  assert.deepEqual(command.filter((argument) => argument === "--platform"), ["--platform", "--platform"]);
  assert.ok(command.includes("ubuntu-latest-low=catthehacker/ubuntu:act-latest"));
  assert.ok(command.includes("gpu=-self-hosted"));
});

test("shared manager streams cursors and redacts secrets", async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), "actui-runs-"));
  await chmod(fixture, 0o755);
  try {
    const manager = new RunManager({ repo: "/tmp", actPath: fixture, workflows: [workflow], trusted: true, storage });
    await manager.initialize();
    const started = await manager.create({ event: "pull_request", workflowIds: ["ci.yml"], secrets: { TOKEN: "super-secret-value" }, initiator: { type: "agent", name: "Test agent" } });
    let cursor = started.cursor;
    let snapshot = manager.get(started.id);
    for (let attempt = 0; attempt < 10 && ["queued", "running", "blocked"].includes(snapshot.status); attempt += 1) {
      const changes = await manager.waitForChanges(started.id, cursor, 1_000);
      cursor = changes.at(-1)?.cursor ?? cursor;
      snapshot = manager.get(started.id);
    }
    assert.equal(snapshot.status, "success");
    assert.equal(snapshot.jobs[0].status, "success");
    assert.ok(snapshot.cursor > started.cursor);
    assert.match(snapshot.logs[1].message, /\*\*\*/);
    assert.doesNotMatch(JSON.stringify(snapshot), /super-secret-value/);
    const compactChanges = manager.changesAfter(started.id, 0);
    assert.ok(compactChanges.length > 0);
    const availableLogs = compactChanges.find((change) => change.type === "logs.available");
    assert.ok(availableLogs?.logRange.count >= 2);
    assert.equal("jobs" in availableLogs, false);
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test("untrusted repositories cannot execute", async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), "actui-runs-"));
  try {
    const manager = new RunManager({ repo: "/tmp", actPath: fixture, workflows: [workflow], trusted: false, storage });
    await manager.initialize();
    await assert.rejects(() => manager.create({ event: "pull_request", workflowIds: ["ci.yml"] }), /not trusted/i);
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test("custom job scopes retain required dependencies", async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), "actui-runs-"));
  const scopedWorkflow = {
    ...workflow,
    jobs: [
      { id: "quality", name: "Quality", needs: [], runner: "ubuntu-latest", steps: 1, requiresApproval: false },
      { id: "test", name: "Test", needs: [], runner: "ubuntu-latest", steps: 1, requiresApproval: false },
      { id: "build", name: "Build", needs: ["quality"], runner: "ubuntu-latest", steps: 1, requiresApproval: false },
    ],
  };
  try {
    const manager = new RunManager({ repo: "/tmp", actPath: fixture, workflows: [scopedWorkflow], trusted: true, storage });
    await manager.initialize();
    const started = await manager.create({
      event: "pull_request",
      workflowIds: ["ci.yml"],
      jobSelections: [{ workflowId: "ci.yml", jobId: "build" }],
    });
    assert.deepEqual(started.jobs.map((job) => job.id), ["quality", "build"]);
    assert.equal(started.jobs[0].status, "queued");
    assert.equal(started.jobs[1].status, "blocked");
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test("a single jobId scopes the shared run state as well as the Act process", async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), "actui-runs-"));
  const scopedWorkflow = {
    ...workflow,
    jobs: [
      { id: "lint", name: "Lint", needs: [], runner: "ubuntu-latest", steps: 1, requiresApproval: false },
      { id: "test", name: "Test", needs: [], runner: "ubuntu-latest", steps: 1, requiresApproval: false },
    ],
  };
  try {
    const manager = new RunManager({ repo: "/tmp", actPath: fixture, workflows: [scopedWorkflow], trusted: true, storage });
    await manager.initialize();
    const started = await manager.create({ event: "pull_request", workflowIds: ["ci.yml"], jobId: "test" });
    assert.deepEqual(started.jobs.map((job) => job.id), ["test"]);
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});
