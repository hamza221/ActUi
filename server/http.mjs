import http from "node:http";

function json(response, status, value) {
  const payload = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_048_576) throw new Error("Request body exceeds 1 MB.");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function proxy(request, response, uiPort) {
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: uiPort,
    path: request.url,
    method: request.method,
    headers: { ...request.headers, host: `127.0.0.1:${uiPort}` },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => json(response, 503, { error: "The ActUI interface is still starting. Refresh in a moment." }));
  request.pipe(upstream);
}

export function createServer({ token, uiPort, health, workflows, manager }) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith("/api/")) return proxy(request, response, uiPort);

    const suppliedToken = request.headers["x-actui-token"] || url.searchParams.get("token");
    if (suppliedToken !== token) return json(response, 401, { error: "Invalid ActUI session token." });
    if (request.method !== "GET" && request.headers.origin) {
      const hostname = new URL(request.headers.origin).hostname;
      if (hostname !== "127.0.0.1" && hostname !== "localhost") return json(response, 403, { error: "ActUI accepts local requests only." });
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, health);
      if (request.method === "GET" && url.pathname === "/api/workflows") return json(response, 200, { workflows });
      if (request.method === "GET" && url.pathname === "/api/runs") return json(response, 200, { runs: manager.list() });
      if (request.method === "POST" && url.pathname === "/api/runs") return json(response, 202, { run: await manager.create(await readBody(request)) });

      const runMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && runMatch) {
        const run = manager.get(runMatch[1]);
        return run ? json(response, 200, { run }) : json(response, 404, { error: "Run not found." });
      }
      const cancelMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/cancel$/i);
      if (request.method === "POST" && cancelMatch) {
        const run = await manager.cancel(cancelMatch[1]);
        return run ? json(response, 200, { run }) : json(response, 404, { error: "Run not found." });
      }
      const eventsMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/events$/i);
      if (request.method === "GET" && eventsMatch) {
        const run = manager.get(eventsMatch[1]);
        if (!run) return json(response, 404, { error: "Run not found." });
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.write(`event: snapshot\ndata: ${JSON.stringify(run)}\n\n`);
        const unsubscribe = manager.subscribe(eventsMatch[1], (next) => response.write(`event: run\ndata: ${JSON.stringify(next)}\n\n`));
        const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
        request.on("close", () => { clearInterval(keepAlive); unsubscribe(); });
        return;
      }
      const changesMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/changes$/i);
      if (request.method === "GET" && changesMatch) {
        const cursor = Math.max(0, Number(url.searchParams.get("after")) || 0);
        const timeout = Math.max(0, Math.min(30_000, Number(url.searchParams.get("timeout")) || 0));
        const changes = timeout
          ? await manager.waitForChanges(changesMatch[1], cursor, timeout)
          : manager.changesAfter(changesMatch[1], cursor);
        return changes === null
          ? json(response, 404, { error: "Run not found." })
          : json(response, 200, { runId: changesMatch[1], afterCursor: cursor, cursor: changes.at(-1)?.cursor ?? cursor, nextCursor: changes.at(-1)?.cursor ?? cursor, changes });
      }
      const failedMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/failed$/i);
      if (request.method === "GET" && failedMatch) {
        const result = manager.failedSteps(failedMatch[1]);
        return result ? json(response, 200, result) : json(response, 404, { error: "Run not found." });
      }
      const logsMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/logs$/i);
      if (request.method === "GET" && logsMatch) {
        const result = manager.readLogs(logsMatch[1], {
          from: Number(url.searchParams.get("from")) || 0,
          to: Number(url.searchParams.get("to")) || Number.MAX_SAFE_INTEGER,
          limit: Number(url.searchParams.get("limit")) || 500,
          failed: url.searchParams.get("failed") === "true",
        });
        return result ? json(response, 200, result) : json(response, 404, { error: "Run not found." });
      }
      const notesMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/notes$/i);
      if (request.method === "POST" && notesMatch) {
        const run = manager.addNote(notesMatch[1], await readBody(request));
        return run ? json(response, 200, { run }) : json(response, 404, { error: "Run not found." });
      }
      const rerunMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/rerun-failed$/i);
      if (request.method === "POST" && rerunMatch) {
        const run = await manager.rerunFailed(rerunMatch[1], await readBody(request));
        return run ? json(response, 202, { run }) : json(response, 404, { error: "Run not found or no longer rerunnable." });
      }
      return json(response, 404, { error: "API route not found." });
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
