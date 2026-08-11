import { apiRequest, readSession } from "./client.mjs";

const tools = [
  ["discover_workflows", "List workflows, triggers, jobs, matrices, and approval risks in the active repository.", { type: "object", properties: {} }],
  ["start_run", "Start the smallest relevant Act-powered workflow run and return its dashboard URL.", { type: "object", required: ["event", "workflowIds"], properties: { event: { type: "string" }, workflowIds: { type: "array", items: { type: "string" } }, jobId: { type: "string" }, secretProfile: { type: "string", description: "Local secret profile name. Requires explicit human approval for agent runs." }, approved: { type: "boolean" }, agentName: { type: "string" }, attempt: { type: "integer" } } }],
  ["wait_for_run", "Wait up to 30 seconds for concise cursor-based run changes.", { type: "object", required: ["runId"], properties: { runId: { type: "string" }, afterCursor: { type: "integer" }, timeoutMs: { type: "integer" } } }],
  ["get_run", "Read the current structured run, job, agent, and audit state.", { type: "object", required: ["runId"], properties: { runId: { type: "string" } } }],
  ["get_failed_steps", "Return only failed workflow/job/step summaries and source annotations.", { type: "object", required: ["runId"], properties: { runId: { type: "string" } } }],
  ["read_logs", "Fetch a bounded selected range of logs instead of the full stream.", { type: "object", required: ["runId"], properties: { runId: { type: "string" }, from: { type: "integer" }, to: { type: "integer" }, limit: { type: "integer" }, failed: { type: "boolean" } } }],
  ["cancel_run", "Cancel an active run shared with the human dashboard.", { type: "object", required: ["runId"], properties: { runId: { type: "string" } } }],
  ["rerun_failed", "Rerun only the smallest failed scope while enforcing the attempt limit.", { type: "object", required: ["runId"], properties: { runId: { type: "string" }, filesChanged: { type: "array", items: { type: "string" } }, approved: { type: "boolean" } } }],
  ["open_dashboard", "Return the local dashboard URL for the active shared session.", { type: "object", properties: {} }],
];

function toolDefinitions() {
  return tools.map(([name, description, inputSchema]) => ({ name, description, inputSchema }));
}

async function callTool(name, args = {}) {
  const session = await readSession();
  if (name === "discover_workflows") return apiRequest("/api/workflows", { session });
  if (name === "start_run") {
    const result = await apiRequest("/api/runs", { method: "POST", session, body: { event: args.event, workflowIds: args.workflowIds, jobId: args.jobId, secretProfile: args.secretProfile, approved: args.approved, initiator: { type: "agent", name: args.agentName || "Coding agent" }, agent: { name: args.agentName || "Coding agent", phase: "testing", attempt: args.attempt || 1, maxAttempts: 3 } } });
    return { ...result, dashboardUrl: `${session.dashboardUrl}#runs` };
  }
  if (name === "wait_for_run") return apiRequest(`/api/runs/${args.runId}/changes?after=${args.afterCursor || 0}&timeout=${Math.min(30_000, args.timeoutMs || 25_000)}`, { session });
  if (name === "get_run") return apiRequest(`/api/runs/${args.runId}`, { session });
  if (name === "get_failed_steps") return apiRequest(`/api/runs/${args.runId}/failed`, { session });
  if (name === "read_logs") return apiRequest(`/api/runs/${args.runId}/logs?from=${args.from || 0}&to=${args.to || Number.MAX_SAFE_INTEGER}&limit=${Math.min(2_000, args.limit || 500)}&failed=${Boolean(args.failed)}`, { session });
  if (name === "cancel_run") return apiRequest(`/api/runs/${args.runId}/cancel`, { method: "POST", session });
  if (name === "rerun_failed") return apiRequest(`/api/runs/${args.runId}/rerun-failed`, { method: "POST", session, body: { filesChanged: args.filesChanged || [], approved: args.approved, initiator: { type: "agent", name: "Coding agent" } } });
  if (name === "open_dashboard") return { dashboardUrl: session.dashboardUrl };
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function readActiveSession() {
  try {
    const session = await readSession();
    const response = await fetch(`${session.url}/api/health`, {
      headers: { "X-ActUI-Token": session.token },
      signal: AbortSignal.timeout(750),
    });
    return response.ok ? session : undefined;
  } catch {
    return undefined;
  }
}

export function mcpStartupBanner(session, { interactive = false } = {}) {
  const lines = [
    "ActUI MCP server ready on stdio — waiting for an MCP client.",
  ];
  if (interactive) {
    lines.push(
      "This is a protocol server, not an interactive shell. It should remain open while your MCP client uses it.",
      "MCP client command: actui mcp",
      session
        ? `Shared dashboard: ${session.dashboardUrl}`
        : "No active ActUI dashboard was found. Start one in another terminal with: actui . --trust",
      "Press Ctrl-C to stop.",
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function runMcpServer() {
  const interactive = Boolean(process.stdin.isTTY || process.stderr.isTTY);
  const session = interactive ? await readActiveSession() : undefined;
  // MCP messages exclusively use stdout. Human-readable lifecycle information
  // belongs on stderr so it cannot corrupt the JSON-RPC transport.
  process.stderr.write(mcpStartupBanner(session, { interactive }));

  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let request;
      try { request = JSON.parse(line); } catch { continue; }
      const base = { jsonrpc: "2.0", id: request.id };
      try {
        if (request.method === "initialize") send({ ...base, result: { protocolVersion: request.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "actui", version: "0.1.0" } } });
        else if (request.method === "notifications/initialized") continue;
        else if (request.method === "ping") send({ ...base, result: {} });
        else if (request.method === "tools/list") send({ ...base, result: { tools: toolDefinitions() } });
        else if (request.method === "tools/call") {
          const result = await callTool(request.params?.name, request.params?.arguments);
          send({ ...base, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
        } else send({ ...base, error: { code: -32601, message: "Method not found" } });
      } catch (error) {
        send({ ...base, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
      }
    }
  }
}
