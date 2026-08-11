import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const ACTIVE = new Set(["queued", "blocked", "running"]);
const MAX_MEMORY_LOGS = 10_000;

function cacheRoot() {
  const base = process.env.XDG_CACHE_HOME || (process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Caches")
    : path.join(os.homedir(), ".cache"));
  return path.join(base, "actui", "runs");
}

function serializable(value) {
  return JSON.parse(JSON.stringify(value));
}

function statusFromMessage(message) {
  const text = message.toLowerCase();
  if (/skip(ped|ping)|condition was false/.test(text)) return "skipped";
  if (/failure|failed|error:|exitcode ['"]?1|job failed/.test(text)) return "failure";
  if (/success|succeeded|complete job/.test(text)) return "success";
  if (/start|run |checkout|pulling|executing/.test(text)) return "running";
  return null;
}

function parseLogfmt(line) {
  const fields = {};
  const pattern = /(?:^|\s)([A-Za-z_][\w.-]*)=("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+)/g;
  for (const match of line.matchAll(pattern)) {
    let value = match[2];
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'")) value = value.slice(1, -1);
    fields[match[1]] = value;
  }
  return Object.keys(fields).length ? fields : null;
}

export function parseLog(line) {
  try {
    const value = JSON.parse(line);
    return {
      time: value.time || new Date().toISOString(),
      level: value.level || "info",
      message: String(value.msg ?? value.message ?? line),
      fields: value,
    };
  } catch {
    const fields = parseLogfmt(line);
    if (fields && !fields.msg) {
      const tail = line.match(/(?:^|\s)msg=(.*)$/)?.[1]?.trim();
      if (tail) fields.msg = tail.replace(/^(["'])(.*)\1$/, "$2");
    }
    if (fields) return {
      time: fields.time || new Date().toISOString(),
      level: fields.level || "info",
      message: String(fields.msg ?? fields.message ?? line),
      fields,
    };
    return { time: new Date().toISOString(), level: "info", message: line, fields: {} };
  }
}

function envFile(record) {
  return Object.entries(record ?? {})
    .map(([key, value]) => `${key}=${String(value).replaceAll("\n", "\\n")}`)
    .join("\n");
}

export class RunManager {
  constructor({ repo, actPath, actInstallation, workflows, trusted = false, storage }) {
    this.repo = repo;
    this.actPath = actPath;
    this.actInstallation = actInstallation;
    this.workflows = new Map(workflows.map((workflow) => [workflow.id, workflow]));
    this.runs = new Map();
    this.children = new Map();
    this.events = new EventEmitter();
    this.events.setMaxListeners(100);
    this.storage = storage ?? cacheRoot();
    this.trusted = trusted;
    this.changes = new Map();
    this.rerunRequests = new Map();
    this.redactions = new Map();
    this.snapshotTimers = new Map();
    this.persistTimers = new Map();
  }

  async initialize() {
    await mkdir(this.storage, { recursive: true });
    try {
      const files = (await readdir(this.storage)).filter((file) => file.endsWith(".json")).sort().slice(-20);
      await Promise.all(files.map(async (file) => {
        try {
          const run = JSON.parse(await readFile(path.join(this.storage, file), "utf8"));
          if (ACTIVE.has(run.status)) {
            run.status = "cancelled";
            run.completedAt = new Date().toISOString();
          }
          this.runs.set(run.id, run);
        } catch { /* Ignore corrupt history entries. */ }
      }));
    } catch { /* A missing history directory is fine. */ }
  }

  list() {
    return [...this.runs.values()]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 30)
      .map(serializable);
  }

  get(id) {
    const run = this.runs.get(id);
    return run ? serializable(run) : null;
  }

  subscribe(id, listener) {
    const eventName = `run:${id}`;
    this.events.on(eventName, listener);
    return () => this.events.off(eventName, listener);
  }

  emit(run, type = "run.updated", detail = {}) {
    run.cursor = (run.cursor ?? 0) + 1;
    const change = {
      cursor: run.cursor,
      type,
      time: new Date().toISOString(),
      runId: run.id,
      status: run.status,
      ...(type === "log.appended" ? {} : {
        jobs: run.jobs.map((job) => ({ workflowId: job.workflowId, jobId: job.id, status: job.status })),
      }),
      ...detail,
    };
    const list = this.changes.get(run.id) ?? [];
    list.push(change);
    if (list.length > 500) list.splice(0, list.length - 500);
    this.changes.set(run.id, list);
    this.schedulePersist(run, !ACTIVE.has(run.status));
    if (type === "log.appended") {
      if (!this.snapshotTimers.has(run.id)) {
        this.snapshotTimers.set(run.id, setTimeout(() => {
          this.snapshotTimers.delete(run.id);
          this.events.emit(`run:${run.id}`, serializable(run));
        }, 50));
      }
    } else {
      const pending = this.snapshotTimers.get(run.id);
      if (pending) clearTimeout(pending);
      this.snapshotTimers.delete(run.id);
      this.events.emit(`run:${run.id}`, serializable(run));
    }
    this.events.emit(`change:${run.id}`, change);
  }

  schedulePersist(run, immediate = false) {
    const pending = this.persistTimers.get(run.id);
    if (pending) clearTimeout(pending);
    if (immediate) {
      this.persistTimers.delete(run.id);
      void this.persist(run);
      return;
    }
    this.persistTimers.set(run.id, setTimeout(() => {
      this.persistTimers.delete(run.id);
      void this.persist(run);
    }, 250));
  }

  async persist(run) {
    try {
      await writeFile(path.join(this.storage, `${run.id}.json`), JSON.stringify(run), { mode: 0o600 });
    } catch { /* History persistence must never fail an active workflow. */ }
  }

  async create(request) {
    if (!this.trusted) throw new Error("This repository is not trusted. Restart with --trust after reviewing its workflows.");
    if (!this.actPath) {
      const setup = this.actInstallation;
      throw new Error(setup
        ? `Act is not installed. Detected ${setup.os}. Run \`${setup.command}\`, restart ActUI, or use --act-path /absolute/path/to/act. Docs: ${setup.docsUrl}`
        : "Act is not installed. Install nektos/act, restart ActUI, or launch with --act-path /absolute/path/to/act.");
    }
    const selected = [...new Set(request.workflowIds ?? [])].map((id) => this.workflows.get(id));
    if (!selected.length || selected.some((item) => !item)) throw new Error("Select one or more valid workflows.");
    if (!request.event || typeof request.event !== "string") throw new Error("A workflow event is required.");
    const riskyJobs = selected.flatMap((workflow) => workflow.jobs.filter((job) => job.requiresApproval));
    if (riskyJobs.length && !request.approved) throw new Error(`Approval required for: ${riskyJobs.map((job) => job.name).join(", ")}. Review the exact command and approve the run.`);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const requestedJobs = Array.isArray(request.jobSelections) ? request.jobSelections : [];
    if (requestedJobs.length) {
      const invalidSelection = requestedJobs.find((item) => {
        const workflow = selected.find((candidate) => candidate.id === item.workflowId);
        return !workflow?.jobs.some((job) => job.id === item.jobId);
      });
      if (invalidSelection) throw new Error(`Unknown job selection: ${invalidSelection.workflowId}/${invalidSelection.jobId}.`);
      const emptyWorkflow = selected.find((workflow) => !requestedJobs.some((item) => item.workflowId === workflow.id));
      if (emptyWorkflow) throw new Error(`Select at least one job from ${emptyWorkflow.name}.`);
    }
    const jobs = selected.flatMap((workflow) => {
      const targets = requestedJobs.filter((item) => item.workflowId === workflow.id).map((item) => item.jobId);
      const included = new Set(targets);
      const includeDependencies = (jobId) => {
        const job = workflow.jobs.find((candidate) => candidate.id === jobId);
        for (const dependency of job?.needs ?? []) {
          if (!included.has(dependency)) included.add(dependency);
          includeDependencies(dependency);
        }
      };
      targets.forEach(includeDependencies);
      const scopedJobs = requestedJobs.length ? workflow.jobs.filter((job) => included.has(job.id)) : workflow.jobs;
      return scopedJobs.map((job) => ({
        ...job,
        workflowId: workflow.id,
        status: job.needs.some((dependency) => included.has(dependency) || !requestedJobs.length) ? "blocked" : "queued",
      }));
    });
    const run = {
      id,
      event: request.event,
      status: "queued",
      createdAt: now,
      workflowIds: selected.map((workflow) => workflow.id),
      jobs,
      logs: [],
      exitCode: null,
      cursor: 0,
      initiator: request.initiator ?? { type: "human", name: "Local user" },
      agent: {
        connected: request.initiator?.type === "agent",
        name: request.agent?.name ?? (request.initiator?.type === "agent" ? request.initiator.name : undefined),
        phase: request.agent?.phase ?? (request.initiator?.type === "agent" ? "testing" : undefined),
        attempt: Math.max(1, Number(request.agent?.attempt) || 1),
        maxAttempts: Math.max(1, Math.min(10, Number(request.agent?.maxAttempts) || 3)),
        filesChanged: Array.isArray(request.agent?.filesChanged) ? request.agent.filesChanged.slice(0, 200) : [],
        notes: [],
      },
      audit: [],
    };
    run.audit.push({ cursor: 0, time: now, actor: run.initiator.name, action: "run.created", detail: `${request.event}: ${selected.map((workflow) => workflow.name).join(", ")}` });
    this.runs.set(id, run);
    this.children.set(id, new Set());
    this.redactions.set(id, new Set(Object.values(request.secrets ?? {}).map(String).filter((value) => value.length >= 3)));
    this.rerunRequests.set(id, { ...request, secrets: undefined });
    this.emit(run, "run.created", { initiator: run.initiator, command: this.commandPreview(selected, request) });
    void this.execute(run, selected, request);
    return serializable(run);
  }

  async execute(run, workflows, request) {
    run.status = "running";
    run.startedAt = new Date().toISOString();
    this.emit(run, "run.started");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "actui-run-"));
    try {
      const eventPath = path.join(tempDir, "event.json");
      const payload = { ...(request.eventPayload ?? {}) };
      if (request.inputs && Object.keys(request.inputs).length) payload.inputs = request.inputs;
      const secretPath = path.join(tempDir, "secrets.env");
      const varPath = path.join(tempDir, "vars.env");
      const envPath = path.join(tempDir, "env.env");
      await Promise.all([
        writeFile(eventPath, JSON.stringify(payload), { mode: 0o600 }),
        writeFile(secretPath, envFile(request.secrets), { mode: 0o600 }),
        writeFile(varPath, envFile(request.vars), { mode: 0o600 }),
        writeFile(envPath, envFile(request.env), { mode: 0o600 }),
      ]);

      const results = await Promise.all(workflows.map(async (workflow) => ({ workflowId: workflow.id, code: await this.executeWorkflow(
        run,
        workflow,
        request,
        { eventPath, secretPath, varPath, envPath, tempDir },
      ) })));
      const failed = results.some((result) => result.code !== 0);
      const nothingRan = run.jobs.length > 0 && run.jobs.every((job) => job.status === "skipped" || job.status === "blocked");
      if (run.status !== "cancelled") run.status = failed ? "failure" : nothingRan ? "skipped" : "success";
      run.exitCode = failed ? 1 : 0;
      for (const job of run.jobs) {
        const workflowFailed = results.find((result) => result.workflowId === job.workflowId)?.code !== 0;
        if (ACTIVE.has(job.status)) job.status = workflowFailed ? (job.status === "running" ? "failure" : "skipped") : run.status === "skipped" ? "skipped" : "success";
        if (!job.completedAt && !ACTIVE.has(job.status)) job.completedAt = new Date().toISOString();
      }
    } catch (error) {
      if (run.status !== "cancelled") run.status = "failure";
      this.appendLog(run, {
        time: new Date().toISOString(),
        level: "error",
        message: error instanceof Error ? error.message : String(error),
        fields: {},
      });
      run.exitCode = 1;
    } finally {
      run.completedAt = new Date().toISOString();
      this.children.delete(run.id);
      this.redactions.delete(run.id);
      await rm(tempDir, { recursive: true, force: true });
      run.audit.push({ cursor: run.cursor ?? 0, time: run.completedAt, actor: "ActUI", action: `run.${run.status}` });
      this.emit(run, `run.${run.status}`);
    }
  }

  executeWorkflow(run, workflow, request, files) {
    return new Promise((resolve) => {
      const concurrency = Math.max(1, Math.min(64, Number(request.concurrency) || 1));
      const args = [
        request.event,
        "--directory", this.repo,
        "--workflows", workflow.absolutePath,
        "--json",
        "--eventpath", files.eventPath,
        "--secret-file", files.secretPath,
        "--var-file", files.varPath,
        "--env-file", files.envPath,
        "--concurrent-jobs", String(concurrency),
      ];
      const selectedJobIds = Array.isArray(request.jobSelections)
        ? request.jobSelections.filter((item) => item.workflowId === workflow.id).map((item) => item.jobId)
        : request.jobId ? [request.jobId] : [];
      for (const jobId of selectedJobIds) args.push("--job", jobId);
      if (request.architecture) args.push("--container-architecture", request.architecture);
      for (const platform of Array.isArray(request.platform) ? request.platform : request.platform ? [request.platform] : []) {
        args.push("--platform", platform);
      }
      if (request.offline) args.push("--action-offline-mode");
      if (request.pull === false) args.push("--pull=false");
      if (request.verbose) args.push("--verbose");
      if (request.artifacts) args.push(
        "--artifact-server-path", path.join(files.tempDir, "artifacts", workflow.id.replaceAll("/", "-")),
        "--artifact-server-port", "0",
      );
      for (const [name, values] of Object.entries(request.matrix ?? {})) {
        for (const value of Array.isArray(values) ? values : [values]) args.push("--matrix", `${name}:${value}`);
      }

      const child = spawn(this.actPath, args, {
        cwd: this.repo,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.children.get(run.id)?.add(child);
      const buffers = { stdout: "", stderr: "" };
      const consume = (kind) => (chunk) => {
        const lines = `${buffers[kind]}${chunk.toString("utf8")}`.split(/\r?\n/);
        buffers[kind] = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) this.appendLog(run, parseLog(line), workflow);
      };
      child.stdout.on("data", consume("stdout"));
      child.stderr.on("data", consume("stderr"));
      child.on("error", (error) => this.appendLog(run, { time: new Date().toISOString(), level: "error", message: error.message, fields: {} }, workflow));
      child.on("close", (code, signal) => {
        if (buffers.stdout.trim()) this.appendLog(run, parseLog(buffers.stdout), workflow);
        if (buffers.stderr.trim()) this.appendLog(run, parseLog(buffers.stderr), workflow);
        this.children.get(run.id)?.delete(child);
        resolve(signal && run.status === "cancelled" ? 130 : (code ?? 1));
      });
    });
  }

  appendLog(run, parsed, workflow) {
    const fields = parsed.fields ?? {};
    const prefix = String(fields.jobID ?? fields.job ?? fields.job_id ?? fields.stage ?? "");
    const haystack = `${prefix} ${parsed.message}`.toLowerCase();
    const candidates = workflow ? run.jobs.filter((job) => job.workflowId === workflow.id) : run.jobs;
    const job = candidates.find((candidate) => fields.jobID === candidate.id || haystack.includes(candidate.id.toLowerCase()) || haystack.includes(candidate.name.toLowerCase()));
    let nextStatus = fields.jobResult === "success" ? "success" : fields.jobResult === "failure" ? "failure" : statusFromMessage(parsed.message);
    if (fields.stepResult === "failure") nextStatus = "failure";
    else if (fields.stepResult === "success" && fields.step !== "Complete job" && nextStatus === "success") nextStatus = "running";
    if (job && nextStatus) {
      if (!job.startedAt && nextStatus === "running") job.startedAt = parsed.time;
      if (fields.step && !["Set up job", "Complete job"].includes(fields.step)) job.currentStep = String(fields.step);
      job.status = nextStatus;
      if (!ACTIVE.has(nextStatus)) job.completedAt = parsed.time;
      if (nextStatus === "success") {
        for (const dependent of run.jobs.filter((candidate) => candidate.needs.includes(job.id) && candidate.status === "blocked")) dependent.status = "queued";
      }
    }
    let safeMessage = parsed.message;
    for (const secret of this.redactions.get(run.id) ?? []) safeMessage = safeMessage.split(secret).join("***");
    run.logs.push({
      id: (run.logs.at(-1)?.id ?? 0) + 1,
      time: parsed.time,
      level: parsed.level,
      message: safeMessage,
      ...(workflow ? { workflowId: workflow.id } : {}),
      ...(job ? { jobId: job.id } : {}),
    });
    if (run.logs.length > MAX_MEMORY_LOGS) run.logs.splice(0, run.logs.length - MAX_MEMORY_LOGS);
    const latest = run.logs.at(-1);
    this.emit(run, "log.appended", { log: { id: latest.id, level: latest.level, workflowId: latest.workflowId, jobId: latest.jobId } });
  }

  async cancel(id) {
    const run = this.runs.get(id);
    if (!run) return null;
    if (!ACTIVE.has(run.status)) return serializable(run);
    run.status = "cancelled";
    run.completedAt = new Date().toISOString();
    for (const job of run.jobs) if (ACTIVE.has(job.status)) job.status = "cancelled";
    for (const child of this.children.get(id) ?? []) child.kill("SIGINT");
    run.audit.push({ cursor: run.cursor ?? 0, time: run.completedAt, actor: "Local user", action: "run.cancelled" });
    this.emit(run, "run.cancelled");
    return serializable(run);
  }

  commandPreview(workflows, request) {
    const args = ["act", request.event];
    if (workflows.length === 1) args.push("--workflows", workflows[0].path);
    if (request.jobId) args.push("--job", request.jobId);
    for (const selection of request.jobSelections ?? []) args.push("--job", selection.jobId);
    args.push("--json", "--concurrent-jobs", String(Math.max(1, Math.min(64, Number(request.concurrency) || 1))));
    if (request.architecture) args.push("--container-architecture", request.architecture);
    for (const platform of Array.isArray(request.platform) ? request.platform : request.platform ? [request.platform] : []) args.push("--platform", platform);
    if (request.offline) args.push("--action-offline-mode");
    if (request.artifacts) args.push("--artifact-server-path", "<temporary-artifact-directory>");
    return args;
  }

  changesAfter(id, cursor = 0) {
    const raw = (this.changes.get(id) ?? []).filter((change) => change.cursor > cursor).slice(0, 500);
    const compact = [];
    let logs = null;
    const flushLogs = () => {
      if (!logs) return;
      compact.push({
        cursor: logs.cursor,
        type: "logs.available",
        time: logs.time,
        runId: logs.runId,
        status: logs.status,
        logRange: { from: logs.from, to: logs.to, count: logs.count },
      });
      logs = null;
    };
    for (const change of raw) {
      if (change.type === "log.appended") {
        logs ??= {
          cursor: change.cursor,
          time: change.time,
          runId: change.runId,
          status: change.status,
          from: change.log.id,
          to: change.log.id,
          count: 0,
        };
        logs.cursor = change.cursor;
        logs.time = change.time;
        logs.status = change.status;
        logs.to = change.log.id;
        logs.count += 1;
        continue;
      }
      flushLogs();
      compact.push(change);
      if (compact.length >= 100) break;
    }
    flushLogs();
    return compact.slice(0, 100).map(serializable);
  }

  async waitForChanges(id, cursor = 0, timeoutMs = 25_000) {
    const existing = this.changesAfter(id, cursor);
    if (existing.length) return existing;
    if (!this.runs.has(id)) return null;
    return new Promise((resolve) => {
      const eventName = `change:${id}`;
      const finish = () => {
        clearTimeout(timer);
        clearTimeout(settleTimer);
        this.events.off(eventName, onChange);
        resolve(this.changesAfter(id, cursor));
      };
      const onChange = (change) => {
        if (change.type === "log.appended") {
          clearTimeout(settleTimer);
          settleTimer = setTimeout(finish, 60);
        } else {
          finish();
        }
      };
      let settleTimer;
      const timer = setTimeout(finish, Math.max(0, Math.min(30_000, timeoutMs)));
      this.events.on(eventName, onChange);
    });
  }

  failedSteps(id) {
    const run = this.runs.get(id);
    if (!run) return null;
    const failures = run.jobs.filter((job) => job.status === "failure").map((job) => {
      const logs = run.logs.filter((entry) => entry.workflowId === job.workflowId && (!entry.jobId || entry.jobId === job.id));
      const error = [...logs].reverse().find((entry) => /error|fail|exit code/i.test(entry.message)) ?? logs.at(-1);
      const annotation = error?.message.match(/(?<file>[^\s:]+\.[a-z0-9]+):(?<line>\d+)(?::(?<column>\d+))?/i)?.groups;
      return {
        workflow: job.workflowId,
        job: job.id,
        step: job.currentStep ?? null,
        exitCode: run.exitCode ?? 1,
        summary: error?.message ?? `${job.name} failed`,
        annotation: annotation ? { file: annotation.file, line: Number(annotation.line), column: annotation.column ? Number(annotation.column) : undefined } : null,
        logRange: logs.length ? { from: logs[0].id, to: logs.at(-1).id } : null,
      };
    });
    return { runId: id, status: run.status, cursor: run.cursor ?? 0, failures };
  }

  readLogs(id, { from = 0, to = Number.MAX_SAFE_INTEGER, failed = false, limit = 500 } = {}) {
    const run = this.runs.get(id);
    if (!run) return null;
    const failedJobs = new Set(run.jobs.filter((job) => job.status === "failure").map((job) => `${job.workflowId}:${job.id}`));
    const logs = run.logs.filter((entry) => entry.id >= from && entry.id <= to && (!failed || !entry.jobId || failedJobs.has(`${entry.workflowId}:${entry.jobId}`))).slice(0, Math.min(2_000, Math.max(1, limit)));
    return { runId: id, cursor: run.cursor ?? 0, logs };
  }

  addNote(id, note) {
    const run = this.runs.get(id);
    if (!run) return null;
    const entry = { id: crypto.randomUUID(), time: new Date().toISOString(), author: String(note.author || "Agent"), body: String(note.body || "").slice(0, 4_000) };
    if (!entry.body) throw new Error("A note body is required.");
    run.agent.notes.push(entry);
    if (note.phase) run.agent.phase = note.phase;
    if (Array.isArray(note.filesChanged)) run.agent.filesChanged = note.filesChanged.slice(0, 200);
    run.audit.push({ cursor: run.cursor ?? 0, time: entry.time, actor: entry.author, action: "agent.note", detail: entry.body });
    this.emit(run, "agent.note", { note: entry, phase: run.agent.phase });
    return serializable(run);
  }

  async rerunFailed(id, options = {}) {
    const previous = this.runs.get(id);
    const request = this.rerunRequests.get(id);
    if (!previous || !request) return null;
    const failed = previous.jobs.filter((job) => job.status === "failure");
    if (!failed.length) throw new Error("This run has no failed jobs to rerun.");
    const attempt = (previous.agent?.attempt ?? 1) + 1;
    if (attempt > (previous.agent?.maxAttempts ?? 3)) throw new Error("The configured retry-attempt limit has been reached.");
    const workflowIds = [...new Set(failed.map((job) => job.workflowId))];
    return this.create({
      ...request,
      workflowIds,
      jobId: failed.length === 1 ? failed[0].id : undefined,
      initiator: options.initiator ?? request.initiator,
      agent: { ...request.agent, attempt, filesChanged: options.filesChanged ?? [] },
      approved: options.approved ?? request.approved,
    });
  }
}
