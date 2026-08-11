import type { Health, Run, Workflow } from "./types";

export const demoHealth: Health = {
  product: "ActUI",
  version: "0.1.0",
  repo: "/Users/you/checkout/acme-web",
  repoName: "acme-web",
  act: { available: true, version: "act version 0.2.88" },
  docker: { available: true, version: "Docker 28.3" },
};

export const demoWorkflows: Workflow[] = [
  {
    id: "ci.yml",
    name: "Continuous integration",
    path: ".github/workflows/ci.yml",
    triggers: ["pull_request", "push"],
    valid: true,
    jobs: [
      { id: "quality", name: "Lint & typecheck", needs: [], runner: "ubuntu-latest", steps: 4 },
      { id: "test", name: "Test suite", needs: [], runner: "ubuntu-latest", steps: 6, matrix: { node: [20, 22] } },
      { id: "build", name: "Production build", needs: ["quality", "test"], runner: "ubuntu-latest", steps: 5 },
    ],
  },
  {
    id: "security.yml",
    name: "Security scan",
    path: ".github/workflows/security.yml",
    triggers: ["pull_request", "schedule"],
    valid: true,
    jobs: [
      { id: "dependencies", name: "Dependency review", needs: [], runner: "ubuntu-latest", steps: 3 },
      { id: "codeql", name: "CodeQL", needs: [], runner: "ubuntu-latest", steps: 7 },
    ],
  },
  {
    id: "release.yml",
    name: "Release",
    path: ".github/workflows/release.yml",
    triggers: ["workflow_dispatch", "release"],
    valid: true,
    jobs: [
      { id: "package", name: "Package artifacts", needs: [], runner: "ubuntu-latest", steps: 5 },
      { id: "publish", name: "Publish release", needs: ["package"], runner: "ubuntu-latest", steps: 4 },
    ],
  },
];

const now = new Date("2026-08-10T16:00:00.000Z");
const created = new Date(now.getTime() - 142_000);

export const demoRuns: Run[] = [
  {
    id: "demo-live",
    event: "pull_request",
    status: "running",
    createdAt: created.toISOString(),
    startedAt: created.toISOString(),
    workflowIds: ["ci.yml", "security.yml"],
    jobs: [
      { ...demoWorkflows[0].jobs[0], workflowId: "ci.yml", status: "success", startedAt: created.toISOString(), completedAt: new Date(created.getTime() + 41_000).toISOString() },
      { ...demoWorkflows[0].jobs[1], workflowId: "ci.yml", status: "running", startedAt: new Date(created.getTime() + 2_000).toISOString() },
      { ...demoWorkflows[0].jobs[2], workflowId: "ci.yml", status: "blocked" },
      { ...demoWorkflows[1].jobs[0], workflowId: "security.yml", status: "success", startedAt: created.toISOString(), completedAt: new Date(created.getTime() + 28_000).toISOString() },
      { ...demoWorkflows[1].jobs[1], workflowId: "security.yml", status: "running", startedAt: new Date(created.getTime() + 1_000).toISOString() },
    ],
    logs: [
      { id: 1, time: new Date(created.getTime() + 44_000).toISOString(), level: "info", jobId: "test", workflowId: "ci.yml", message: "▶ Run npm test -- --coverage" },
      { id: 2, time: new Date(created.getTime() + 45_000).toISOString(), level: "info", jobId: "test", workflowId: "ci.yml", message: "PASS  src/auth/session.test.ts" },
      { id: 3, time: new Date(created.getTime() + 46_000).toISOString(), level: "info", jobId: "test", workflowId: "ci.yml", message: "PASS  src/billing/invoice.test.ts" },
      { id: 4, time: new Date(created.getTime() + 48_000).toISOString(), level: "info", jobId: "codeql", workflowId: "security.yml", message: "Analyzing TypeScript sources…" },
      { id: 5, time: new Date(created.getTime() + 51_000).toISOString(), level: "info", jobId: "test", workflowId: "ci.yml", message: "Tests: 128 passed, 128 total" },
      { id: 6, time: new Date(created.getTime() + 52_000).toISOString(), level: "info", jobId: "test", workflowId: "ci.yml", message: "Generating coverage report" },
    ],
  },
  {
    id: "demo-success",
    event: "push",
    status: "success",
    createdAt: new Date(now.getTime() - 3_640_000).toISOString(),
    completedAt: new Date(now.getTime() - 3_508_000).toISOString(),
    workflowIds: ["ci.yml"],
    jobs: [],
    logs: [],
    exitCode: 0,
  },
];
