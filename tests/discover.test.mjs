import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverWorkflows, publicWorkflow } from "../server/discover.mjs";

test("discovers triggers, dependencies, matrices, and protected jobs", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "actui-discovery-"));
  try {
    const directory = path.join(repo, ".github", "workflows");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "ci.yml"), `
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - name: Unit tests
        run: npm test
  publish:
    name: Publish package
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: npm publish
`);
    const [workflow] = await discoverWorkflows(repo);
    assert.equal(workflow.name, "CI");
    assert.deepEqual(workflow.triggers, ["push", "pull_request"]);
    assert.deepEqual(workflow.jobs[1].needs, ["test"]);
    assert.equal(workflow.jobs[0].stepDefinitions[0].name, "Unit tests");
    assert.equal(workflow.jobs[1].requiresApproval, true);
    assert.equal("absolutePath" in publicWorkflow(workflow), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
