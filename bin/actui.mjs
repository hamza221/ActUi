#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { access, copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { actInstallationFor } from "../server/act-installation.mjs";
import { apiRequest } from "../server/client.mjs";
import { discoverWorkflows, publicWorkflow } from "../server/discover.mjs";
import { createServer } from "../server/http.mjs";
import { runMcpServer } from "../server/mcp.mjs";
import { RunManager } from "../server/run-manager.mjs";
import { resolveDockerHost, resolveGitHubRepository } from "../server/repository-environment.mjs";
import { sessionPath } from "../server/client.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const COMMANDS = new Set(["discover", "run", "wait", "get", "logs", "cancel", "rerun-failed", "mcp", "install-skill"]);

function usage() {
  console.log(`ActUI ${packageJson.version}\n\nLaunch dashboard:\n  actui [repository] --trust\n\nAgent and JSON commands:\n  actui discover [repository] --json\n  actui run --workflow <file> [options] --json\n  actui wait <run-id> [--after-cursor 0] --json\n  actui get <run-id> --json\n  actui logs <run-id> [--failed] [--from 1] [--to 200] --json\n  actui cancel <run-id> --json\n  actui rerun-failed <run-id> [--files a.ts,b.ts] --json\n  actui mcp\n  actui install-skill\n\nRun options:\n  --event <name>              Workflow event (default: pull_request)\n  --event-payload <file>      JSON event payload file\n  --job <id>                  Run a specific job\n  --platform <mapping>        Act runner mapping; repeatable\n  --matrix <name:value>       Matrix filter; repeatable\n  --concurrency <count>       Concurrent Act jobs\n  --architecture <value>      Container architecture\n  --offline                   Use cached actions only\n  --artifacts                 Enable the local artifact server\n  --verbose                   Include Act debug output\n  --approved                  Approve protected jobs\n  --act-arg <argument>        Extra Act argument for this trusted session; repeatable\n  --agent <name>              Agent initiator name\n  --attempt <number>          Current agent attempt\n  --max-attempts <number>     Agent retry limit\n\nLaunch options:\n  --port <port>       Browser-facing port\n  --act-path <path>   Use a specific Act executable\n  --no-open           Do not open the browser\n  --trust             Trust this repository for local workflow execution\n  --version           Print the version\n  --help              Show this help`);
}

function repeated(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function parseMatrix(value) {
  const matrix = {};
  for (const entry of repeated(value)) {
    const separator = entry.indexOf(":");
    if (separator < 1) throw new Error(`Invalid --matrix value: ${entry}. Expected name:value.`);
    const name = entry.slice(0, separator);
    (matrix[name] ??= []).push(entry.slice(separator + 1));
  }
  return matrix;
}

function optionValues(argv) {
  const values = new Map();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--")) {
      const name = value.slice(2);
      if (["json", "failed", "approved", "trust", "no-open", "offline", "artifacts", "verbose"].includes(name)) values.set(name, true);
      else {
        const next = argv[++index];
        if (next === undefined) throw new Error(`Missing value for --${name}.`);
        if (values.has(name)) values.set(name, [].concat(values.get(name), next));
        else values.set(name, next);
      }
    } else positionals.push(value);
  }
  return { values, positionals };
}

function output(value, asJson = true) {
  process.stdout.write(`${asJson ? JSON.stringify(value, null, 2) : String(value)}\n`);
}

async function availablePort(preferred = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: preferred }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : preferred;
      server.close(() => resolve(port));
    });
  });
}

async function findExecutable(name) {
  const command = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(command, [name], { timeout: 2_000 });
    return stdout.trim().split(/\r?\n/)[0] || null;
  } catch { return null; }
}

async function inspect(executable, args, fallback) {
  if (!executable) return { available: false, error: `${fallback} was not found.` };
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, { timeout: 4_000 });
    return { available: true, path: executable, version: (stdout || stderr).trim().split(/\r?\n/)[0] };
  } catch (error) {
    return { available: false, path: executable, error: error instanceof Error ? error.message : String(error) };
  }
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function waitForPort(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port }, () => { socket.end(); resolve(); });
        socket.once("error", reject);
      });
      return;
    } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error("The interface did not start in time.");
}

async function runCommand(command, argv) {
  const { values, positionals } = optionValues(argv);
  if (command === "discover") {
    const repo = await realpath(path.resolve(positionals[0] || "."));
    return output({ repo, workflows: (await discoverWorkflows(repo)).map(publicWorkflow) });
  }
  if (command === "mcp") return runMcpServer();
  if (command === "install-skill") {
    const destination = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills", "actui-test-and-fix");
    await mkdir(path.join(destination, "references"), { recursive: true });
    await mkdir(path.join(destination, "agents"), { recursive: true });
    await Promise.all([
      copyFile(path.join(packageRoot, "skills", "actui-test-and-fix", "SKILL.md"), path.join(destination, "SKILL.md")),
      copyFile(path.join(packageRoot, "skills", "actui-test-and-fix", "references", "event-schema.md"), path.join(destination, "references", "event-schema.md")),
      copyFile(path.join(packageRoot, "skills", "actui-test-and-fix", "agents", "openai.yaml"), path.join(destination, "agents", "openai.yaml")),
    ]);
    return output({ installed: true, destination });
  }
  if (command === "run") {
    const workflow = values.get("workflow");
    const workflowIds = Array.isArray(workflow) ? workflow : workflow ? [workflow] : [];
    let eventPayload;
    if (values.get("event-payload")) {
      const eventPayloadPath = path.resolve(String(values.get("event-payload")));
      eventPayload = JSON.parse(await readFile(eventPayloadPath, "utf8"));
      if (!eventPayload || typeof eventPayload !== "object" || Array.isArray(eventPayload)) throw new Error("--event-payload must contain a JSON object.");
    }
    const result = await apiRequest("/api/runs", { method: "POST", body: {
      event: values.get("event") || "pull_request",
      workflowIds,
      jobId: values.get("job"),
      eventPayload,
      actArgs: repeated(values.get("act-arg")),
      matrix: parseMatrix(values.get("matrix")),
      concurrency: Number(values.get("concurrency")) || 4,
      architecture: values.get("architecture"),
      platform: values.get("platform"),
      offline: Boolean(values.get("offline")),
      artifacts: Boolean(values.get("artifacts")),
      verbose: Boolean(values.get("verbose")),
      approved: Boolean(values.get("approved")),
      initiator: { type: "agent", name: values.get("agent") || "ActUI CLI" },
      agent: { name: values.get("agent") || "ActUI CLI", phase: "testing", attempt: Number(values.get("attempt")) || 1, maxAttempts: Number(values.get("max-attempts")) || 3 },
    } });
    return output(result);
  }
  const id = positionals[0];
  if (!id) throw new Error(`${command} requires a run ID.`);
  if (command === "wait") return output(await apiRequest(`/api/runs/${id}/changes?after=${Number(values.get("after-cursor")) || 0}&timeout=${Math.min(30_000, Number(values.get("timeout")) || 25_000)}`));
  if (command === "get") return output(await apiRequest(`/api/runs/${id}`));
  if (command === "logs") {
    const query = `from=${Number(values.get("from")) || 0}&to=${Number(values.get("to")) || Number.MAX_SAFE_INTEGER}&limit=${Number(values.get("limit")) || 500}&failed=${Boolean(values.get("failed"))}`;
    if (values.get("failed")) {
      const [failureResult, logResult] = await Promise.all([apiRequest(`/api/runs/${id}/failed`), apiRequest(`/api/runs/${id}/logs?${query}`)]);
      return output({ ...failureResult, logs: logResult.logs });
    }
    return output(await apiRequest(`/api/runs/${id}/logs?${query}`));
  }
  if (command === "cancel") return output(await apiRequest(`/api/runs/${id}/cancel`, { method: "POST" }));
  if (command === "rerun-failed") return output(await apiRequest(`/api/runs/${id}/rerun-failed`, { method: "POST", body: { filesChanged: String(values.get("files") || "").split(",").filter(Boolean), approved: Boolean(values.get("approved")), initiator: { type: "agent", name: values.get("agent") || "ActUI CLI" } } }));
}

async function launch(argv) {
  const { values, positionals } = optionValues(argv);
  const repo = await realpath(path.resolve(positionals[0] || "."));
  await access(repo);
  const workflows = await discoverWorkflows(repo);
  let actPath = values.get("act-path") || process.env.ACTUI_ACT_PATH || await findExecutable("act");
  if (actPath) actPath = await realpath(path.resolve(actPath));
  const dockerPath = await findExecutable("docker");
  const [act, docker, dockerHost, githubRepository] = await Promise.all([
    inspect(actPath, ["--version"], "Act"),
    inspect(dockerPath, ["version", "--format", "Docker {{.Server.Version}}"], "Docker"),
    resolveDockerHost(dockerPath),
    resolveGitHubRepository(repo),
  ]);
  const actInstallation = actInstallationFor();
  const trusted = Boolean(values.get("trust"));
  const manager = new RunManager({ repo, actPath: act.available ? actPath : null, actInstallation, workflows, trusted, dockerHost, githubRepository });
  await manager.initialize();

  const token = crypto.randomBytes(24).toString("base64url");
  const mainPort = await availablePort(Number(values.get("port")) || 0);
  const uiPort = await availablePort();
  const vinextBin = path.join(packageRoot, "node_modules", ".bin", process.platform === "win32" ? "vinext.cmd" : "vinext");
  const ui = spawn(vinextBin, ["start", "--host", "127.0.0.1", "--port", String(uiPort)], { cwd: packageRoot, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, NODE_ENV: "production" } });
  ui.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForPort(uiPort);

  const baseUrl = `http://127.0.0.1:${mainPort}`;
  const dashboardUrl = `${baseUrl}/?token=${encodeURIComponent(token)}`;
  const health = { product: "ActUI", version: packageJson.version, repo, repoName: path.basename(repo), act: { ...act, installation: actInstallation }, docker: { ...docker, host: dockerHost }, trusted, dashboardUrl };
  const server = createServer({ token, uiPort, health, workflows: workflows.map(publicWorkflow), manager });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(mainPort, "127.0.0.1", resolve); });
  await mkdir(path.dirname(sessionPath()), { recursive: true });
  await writeFile(sessionPath(), JSON.stringify({ pid: process.pid, repo, url: baseUrl, token, dashboardUrl }), { mode: 0o600 });
  console.log(`\n  ActUI is ready\n  ${dashboardUrl}\n  ${workflows.length} workflow${workflows.length === 1 ? "" : "s"} discovered · Act ${act.available ? "ready" : "not found"} · Docker ${docker.available ? "ready" : "not available"} · ${trusted ? "trusted" : "read-only"}\n`);
  if (!act.available) {
    console.log(`  Act is required before workflows can run. Detected ${actInstallation.os} (${actInstallation.architecture}).\n  Install: ${actInstallation.command}\n  Then verify with: ${actInstallation.verifyCommand}\n  Already installed elsewhere? Relaunch with --act-path /absolute/path/to/act\n  Docs: ${actInstallation.docsUrl}\n`);
  }
  if (!values.get("no-open")) openBrowser(dashboardUrl);

  const shutdown = () => { server.close(); ui.kill("SIGTERM"); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  ui.once("exit", () => server.close());
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) return usage();
  if (argv.includes("--version") || argv.includes("-v")) return console.log(packageJson.version);
  if (COMMANDS.has(argv[0])) return runCommand(argv[0], argv.slice(1));
  return launch(argv);
}

main().catch((error) => {
  console.error(`ActUI: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
