import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const cliPath = new URL("../bin/actui.mjs", import.meta.url);

test("MCP announces readiness on stderr without contaminating JSON-RPC stdout", async () => {
  const child = spawn(process.execPath, [cliPath.pathname, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  child.stdin.end(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26" },
  })}\n`);

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0);
  assert.match(stderr, /ActUI MCP server ready on stdio/);

  const messages = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 1);
  assert.equal(messages[0].result.serverInfo.name, "actui");
});
