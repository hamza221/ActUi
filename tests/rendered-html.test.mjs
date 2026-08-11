import assert from "node:assert/strict";
import test from "node:test";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);

async function render(pathname = "/") {
  const url = new URL(workerUrl);
  url.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(url.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the ActUI dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>ActUI — GitHub Actions, running locally<\/title>/i);
  assert.match(html, /Run your CI\. Stay in flow\./);
  assert.match(html, /Powered by/);
  assert.match(html, /nektos\/act/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("server-renders the in-product handbook", async () => {
  const response = await render("/docs");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /ActUI handbook/);
  assert.match(html, /Provider-neutral CLI/);
  assert.match(html, /Local MCP server/);
  assert.match(html, /Trust and safety/);
});
