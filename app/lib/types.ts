export type RunStatus =
  | "queued"
  | "blocked"
  | "running"
  | "success"
  | "failure"
  | "cancelled"
  | "skipped";

export type WorkflowJob = {
  id: string;
  name: string;
  needs: string[];
  runner: string;
  steps: number;
  stepDefinitions?: { id: string; name: string; uses?: string }[];
  requiresApproval?: boolean;
  matrix?: Record<string, unknown>;
};

export type Workflow = {
  id: string;
  name: string;
  path: string;
  triggers: string[];
  jobs: WorkflowJob[];
  valid: boolean;
  error?: string;
};

export type RunJob = WorkflowJob & {
  workflowId: string;
  status: RunStatus;
  startedAt?: string;
  completedAt?: string;
  currentStep?: string;
};

export type LogEntry = {
  id: number;
  time: string;
  level: string;
  message: string;
  workflowId?: string;
  jobId?: string;
};

export type Run = {
  id: string;
  event: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  workflowIds: string[];
  jobs: RunJob[];
  logs: LogEntry[];
  exitCode?: number | null;
  cursor?: number;
  initiator?: { type: "human" | "agent"; name: string };
  agent?: {
    connected: boolean;
    name?: string;
    phase?: "testing" | "inspecting" | "fixing" | "waiting";
    attempt: number;
    maxAttempts: number;
    filesChanged: string[];
    notes: { id: string; time: string; author: string; body: string }[];
  };
  audit?: { cursor: number; time: string; actor: string; action: string; detail?: string }[];
};

export type Health = {
  product: string;
  version: string;
  repo: string;
  repoName: string;
  act: {
    available: boolean;
    path?: string;
    version?: string;
    error?: string;
    installation?: {
      platform: string;
      os: string;
      architecture: string;
      packageManager: string;
      command: string;
      alternatives: string[];
      verifyCommand: string;
      docsUrl: string;
      mitigations: string[];
    };
  };
  docker: { available: boolean; version?: string; error?: string };
  trusted?: boolean;
  dashboardUrl?: string;
};

export type RunRequest = {
  event: string;
  workflowIds: string[];
  jobId?: string;
  jobSelections?: { workflowId: string; jobId: string }[];
  eventPayload?: Record<string, unknown>;
  inputs?: Record<string, string>;
  secrets?: Record<string, string>;
  vars?: Record<string, string>;
  env?: Record<string, string>;
  matrix?: Record<string, string[]>;
  concurrency?: number;
  architecture?: string;
  platform?: string | string[];
  offline?: boolean;
  pull?: boolean;
  artifacts?: boolean;
  verbose?: boolean;
  initiator?: { type: "human" | "agent"; name: string };
  agent?: { name?: string; phase?: string; attempt?: number; maxAttempts?: number; filesChanged?: string[] };
  approved?: boolean;
};
