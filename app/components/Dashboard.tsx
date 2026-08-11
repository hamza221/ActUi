"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { demoHealth, demoRuns, demoWorkflows } from "../lib/demo";
import type { Health, LogEntry, Run, RunJob, RunRequest, RunStatus, SecretProfile, SecretStoreSummary, Workflow } from "../lib/types";

const EVENT_LABELS: Record<string, string> = {
  pull_request: "Pull request",
  push: "Push",
  workflow_dispatch: "Manual",
  schedule: "Schedule",
  release: "Release",
};

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  blocked: "Waiting",
  running: "Running",
  success: "Passed",
  failure: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

type JobPreset = { id: string; name: string; event: string; jobs: string[] };
type AppView = "workflows" | "runs" | "secrets" | "environment";
const RUN_OUTPUT_KEY = "__run_output__";
const ACT_BUILTIN_RUNNERS = new Set(["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04", "ubuntu-20.04", "ubuntu-18.04", "self-hosted"]);

function jobKey(workflowId: string, jobId: string) {
  return JSON.stringify([workflowId, jobId]);
}

function parseJobKey(value: string) {
  const [workflowId, jobId] = JSON.parse(value) as [string, string];
  return { workflowId, jobId };
}

function consoleSteps(job: RunJob) {
  if (job.stepDefinitions?.length) return job.stepDefinitions;
  return Array.from({ length: job.steps }, (_, index) => ({ id: `step-${index + 1}`, name: `Step ${index + 1}` }));
}

function consoleStepStatus(job: RunJob, stepName: string, index: number): RunStatus {
  if (job.status === "success" || job.status === "cancelled" || job.status === "skipped") return job.status;
  const steps = consoleSteps(job);
  const currentIndex = job.currentStep ? steps.findIndex((step) => step.name === job.currentStep) : -1;
  if (job.status === "failure") return currentIndex < 0 ? (index === steps.length - 1 ? "failure" : "success") : index === currentIndex ? "failure" : index < currentIndex ? "success" : "queued";
  if (job.status === "running") return index === currentIndex || (currentIndex < 0 && index === 0) ? "running" : index < currentIndex ? "success" : "queued";
  return job.status;
}

function platformMappings(value: string) {
  return value.split(/[,\n]+/).map((mapping) => mapping.trim()).filter(Boolean);
}

function runnerSuggestion(runner: string) {
  if (runner.startsWith("ubuntu-")) return `${runner}=catthehacker/ubuntu:act-latest`;
  return `${runner}=-self-hosted`;
}

function sessionToken() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body) headers.set("Content-Type", "application/json");
  const token = sessionToken();
  if (token) headers.set("X-ActUI-Token", token);
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(detail.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function StatusMark({ status }: { status: RunStatus }) {
  return <span className={`status-mark status-${status}`} aria-hidden="true" />;
}

function TriggerBadge({ event }: { event: string }) {
  return <span className="trigger-badge">{EVENT_LABELS[event] ?? event.replaceAll("_", " ")}</span>;
}

function formatDuration(start?: string, end?: string, now = 0) {
  if (!start) return "—";
  const duration = Math.max(0, new Date(end ?? now).getTime() - new Date(start).getTime());
  if (duration < 60_000) return `${Math.max(1, Math.round(duration / 1_000))}s`;
  const minutes = Math.floor(duration / 60_000);
  return `${minutes}m ${Math.round((duration % 60_000) / 1_000)}s`;
}

function ago(value: string, now: number) {
  const seconds = Math.max(1, Math.round((now - new Date(value).getTime()) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function clockTime(value: string) {
  return value.match(/T(\d{2}:\d{2}:\d{2})/)?.[1] ?? value;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <span className="empty-glyph" aria-hidden="true">◇</span>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

export function Dashboard() {
  const [health, setHealth] = useState<Health>(demoHealth);
  const [view, setView] = useState<AppView>("workflows");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const [workflows, setWorkflows] = useState<Workflow[]>(demoWorkflows);
  const [runs, setRuns] = useState<Run[]>(demoRuns);
  const [connected, setConnected] = useState(false);
  const [activeRunId, setActiveRunId] = useState(demoRuns[0].id);
  const [activeJobKey, setActiveJobKey] = useState(jobKey("ci.yml", "test"));
  const [selectedEvent, setSelectedEvent] = useState("pull_request");
  const [selectedWorkflows, setSelectedWorkflows] = useState<Set<string>>(
    new Set(demoWorkflows.filter((workflow) => workflow.triggers.includes("pull_request")).map((workflow) => workflow.id)),
  );
  const [selectedJobs, setSelectedJobs] = useState<Set<string>>(new Set(
    demoWorkflows.filter((workflow) => workflow.triggers.includes("pull_request")).flatMap((workflow) => workflow.jobs.map((job) => jobKey(workflow.id, job.id))),
  ));
  const [jobPresets, setJobPresets] = useState<JobPreset[]>([]);
  const [activePresetId, setActivePresetId] = useState("");
  const [presetName, setPresetName] = useState("");
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [logQuery, setLogQuery] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const [showActHelp, setShowActHelp] = useState(false);
  const [copiedInstall, setCopiedInstall] = useState(false);
  const [consoleFullscreen, setConsoleFullscreen] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [secretProfiles, setSecretProfiles] = useState<SecretProfile[]>([]);
  const [secretStoragePath, setSecretStoragePath] = useState("");
  const [selectedSecretProfile, setSelectedSecretProfile] = useState("");
  const [newProfileName, setNewProfileName] = useState("");
  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [secretBusy, setSecretBusy] = useState(false);
  const [advanced, setAdvanced] = useState({ concurrency: 4, architecture: "", platform: "", offline: false, artifacts: true, verbose: false, approved: false });

  useEffect(() => {
    let current = true;
    Promise.all([
      api<Health>("/api/health"),
      api<{ workflows: Workflow[] }>("/api/workflows"),
      api<{ runs: Run[] }>("/api/runs"),
      api<SecretStoreSummary>("/api/secrets"),
    ]).then(([healthData, workflowData, runData, secretData]) => {
      if (!current) return;
      setHealth(healthData);
      setWorkflows(workflowData.workflows);
      const initialEvent = workflowData.workflows.some((workflow) => workflow.triggers.includes("pull_request"))
        ? "pull_request"
        : workflowData.workflows[0]?.triggers[0] ?? "workflow_dispatch";
      const defaultWorkflows = workflowData.workflows.filter((workflow) => workflow.triggers.includes(initialEvent));
      let nextEvent = initialEvent;
      let nextJobs = new Set(defaultWorkflows.flatMap((workflow) => workflow.jobs.map((job) => jobKey(workflow.id, job.id))));
      try {
        const stored = JSON.parse(window.localStorage.getItem(`actui:job-lists:${healthData.repo}`) ?? "null") as { presets?: JobPreset[]; activeId?: string } | null;
        const storedPresets = stored?.presets?.filter((preset) => preset.id && preset.name && Array.isArray(preset.jobs)) ?? [];
        setJobPresets(storedPresets);
        const active = storedPresets.find((preset) => preset.id === stored?.activeId);
        if (active) {
          nextEvent = active.event;
          nextJobs = new Set(active.jobs);
          setActivePresetId(active.id);
        }
      } catch { /* Ignore malformed device-local preferences. */ }
      setSelectedEvent(nextEvent);
      setSelectedJobs(nextJobs);
      setSelectedWorkflows(new Set([...nextJobs].map((key) => parseJobKey(key).workflowId)));
      setPresetsLoaded(true);
      setRuns(runData.runs);
      setSecretProfiles(secretData.profiles);
      setSecretStoragePath(secretData.storagePath);
      setConnected(true);
      if (runData.runs[0]) setActiveRunId((activeId) => activeId.startsWith("demo-") ? runData.runs[0].id : activeId);
    }).catch(() => { if (current) setConnected(false); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (!connected || !presetsLoaded) return;
    window.localStorage.setItem(`actui:job-lists:${health.repo}`, JSON.stringify({ presets: jobPresets, activeId: activePresetId }));
  }, [activePresetId, connected, health.repo, jobPresets, presetsLoaded]);

  useEffect(() => {
    if (!consoleFullscreen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setConsoleFullscreen(false); };
    document.body.classList.add("console-is-fullscreen");
    window.addEventListener("keydown", close);
    return () => {
      document.body.classList.remove("console-is-fullscreen");
      window.removeEventListener("keydown", close);
    };
  }, [consoleFullscreen]);

  useEffect(() => {
    if (paletteOpen) paletteInputRef.current?.focus();
  }, [paletteOpen]);

  useEffect(() => {
    const readHash = () => {
      const next = window.location.hash.slice(1);
      if (next === "workflows" || next === "runs" || next === "secrets" || next === "environment") setView(next);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (event.key === "Escape") {
        setPaletteOpen(false);
      }
    };
    readHash();
    window.addEventListener("hashchange", readHash);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("hashchange", readHash);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setNow(Date.now()));
    const interval = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => { cancelAnimationFrame(frame); window.clearInterval(interval); };
  }, []);

  const activeRun = runs.find((run) => run.id === activeRunId) ?? runs[0];
  const activeSecretProfile = secretProfiles.find((profile) => profile.name === selectedSecretProfile);
  const runOutputSelected = activeJobKey === RUN_OUTPUT_KEY || !activeRun?.jobs.length;
  const activeJob = runOutputSelected ? undefined : activeRun?.jobs.find((job) => jobKey(job.workflowId, job.id) === activeJobKey) ?? activeRun?.jobs[0];
  const streamedRunId = activeRun?.id;
  const activeRunStatus = activeRun?.status;

  useEffect(() => {
    if (!connected || !streamedRunId || !activeRunStatus || !["queued", "running", "blocked"].includes(activeRunStatus)) return;
    const token = sessionToken();
    const source = new EventSource(`/api/runs/${streamedRunId}/events${token ? `?token=${encodeURIComponent(token)}` : ""}`);
    source.addEventListener("snapshot", (event) => {
      const run = JSON.parse((event as MessageEvent).data) as Run;
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
    });
    source.addEventListener("run", (event) => {
      const run = JSON.parse((event as MessageEvent).data) as Run;
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
    });
    source.onerror = () => source.close();
    return () => source.close();
  }, [activeRunStatus, connected, streamedRunId]);

  const events = useMemo(() => {
    const found = new Set(workflows.flatMap((workflow) => workflow.triggers));
    return [...found].sort((a, b) => (a === "pull_request" ? -1 : b === "pull_request" ? 1 : a.localeCompare(b)));
  }, [workflows]);

  const eventWorkflows = useMemo(
    () => workflows.filter((workflow) => workflow.triggers.includes(selectedEvent) && workflow.name.toLowerCase().includes(query.toLowerCase())),
    [query, selectedEvent, workflows],
  );

  const unsupportedRunners = useMemo(() => {
    const selected = new Set([...selectedJobs].map((key) => jobKey(parseJobKey(key).workflowId, parseJobKey(key).jobId)));
    const configured = new Set(platformMappings(advanced.platform).map((mapping) => mapping.split("=")[0]));
    return [...new Set(workflows.flatMap((workflow) => workflow.jobs
      .filter((job) => selected.has(jobKey(workflow.id, job.id)))
      .map((job) => job.runner)
      .filter((runner) => runner && !runner.includes("${{") && !ACT_BUILTIN_RUNNERS.has(runner) && !configured.has(runner))))];
  }, [advanced.platform, selectedJobs, workflows]);

  const visibleLogs = useMemo(() => {
    if (!activeRun) return [];
    const normalized = logQuery.trim().toLowerCase();
    return activeRun.logs.filter((entry) => {
      const matchesJob = runOutputSelected
        ? !entry.jobId
        : Boolean(activeJob && entry.jobId === activeJob.id && entry.workflowId === activeJob.workflowId);
      return matchesJob && (!normalized || entry.message.toLowerCase().includes(normalized));
    });
  }, [activeJob, activeRun, logQuery, runOutputSelected]);

  const chooseEvent = (event: string) => {
    const matching = workflows.filter((workflow) => workflow.triggers.includes(event));
    setSelectedEvent(event);
    setSelectedWorkflows(new Set(matching.map((workflow) => workflow.id)));
    setSelectedJobs(new Set(matching.flatMap((workflow) => workflow.jobs.map((job) => jobKey(workflow.id, job.id)))));
    setActivePresetId("");
  };

  const navigateView = (next: AppView) => {
    setView(next);
    setPaletteOpen(false);
    setPaletteQuery("");
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${next}`);
  };

  const toggleWorkflow = (id: string) => {
    setSelectedWorkflows((current) => {
      const next = new Set(current);
      const removing = next.has(id);
      if (removing) next.delete(id);
      else next.add(id);
      setSelectedJobs((currentJobs) => {
        const jobs = new Set(currentJobs);
        for (const job of workflows.find((workflow) => workflow.id === id)?.jobs ?? []) {
          const key = jobKey(id, job.id);
          if (removing) jobs.delete(key);
          else jobs.add(key);
        }
        return jobs;
      });
      setActivePresetId("");
      return next;
    });
  };

  const toggleJob = (workflowId: string, jobId: string) => {
    const key = jobKey(workflowId, jobId);
    setSelectedJobs((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      const workflowStillSelected = [...next].some((item) => parseJobKey(item).workflowId === workflowId);
      setSelectedWorkflows((workflowsSelected) => {
        const nextWorkflows = new Set(workflowsSelected);
        if (workflowStillSelected) nextWorkflows.add(workflowId);
        else nextWorkflows.delete(workflowId);
        return nextWorkflows;
      });
      return next;
    });
    setActivePresetId("");
  };

  const applyPreset = (id: string) => {
    setActivePresetId(id);
    const preset = jobPresets.find((item) => item.id === id);
    if (!preset) return;
    setSelectedEvent(preset.event);
    setSelectedJobs(new Set(preset.jobs));
    setSelectedWorkflows(new Set(preset.jobs.map((key) => parseJobKey(key).workflowId)));
  };

  const savePreset = () => {
    const name = presetName.trim();
    if (!name || !selectedJobs.size) {
      setNotice("Name the list and select at least one job.");
      return;
    }
    const id = crypto.randomUUID();
    const preset = { id, name, event: selectedEvent, jobs: [...selectedJobs] };
    setJobPresets((current) => [...current, preset]);
    setActivePresetId(id);
    setPresetName("");
    setNotice(`Saved “${name}” for ${health.repoName}.`);
  };

  const deletePreset = () => {
    if (!activePresetId) return;
    setJobPresets((current) => current.filter((preset) => preset.id !== activePresetId));
    setActivePresetId("");
  };

  const applySecretSummary = (summary: SecretStoreSummary) => {
    setSecretProfiles(summary.profiles);
    setSecretStoragePath(summary.storagePath);
  };

  const createSecretProfile = async (event: FormEvent) => {
    event.preventDefault();
    const name = newProfileName.trim();
    if (!name) return setNotice("Enter a profile name.");
    setSecretBusy(true);
    try {
      const summary = await api<SecretStoreSummary>("/api/secrets/profiles", { method: "POST", body: JSON.stringify({ name }) });
      applySecretSummary(summary);
      setSelectedSecretProfile(name);
      setNewProfileName("");
      setNotice(`Created local secret profile “${name}”.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to create the secret profile.");
    } finally {
      setSecretBusy(false);
    }
  };

  const saveSecret = async (event: FormEvent) => {
    event.preventDefault();
    const name = newSecretName.trim();
    if (!selectedSecretProfile) return setNotice("Select a secret profile first.");
    if (!name) return setNotice("Enter a secret name.");
    setSecretBusy(true);
    try {
      const summary = await api<SecretStoreSummary>(`/api/secrets/profiles/${encodeURIComponent(selectedSecretProfile)}/secrets/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify({ value: newSecretValue }),
      });
      applySecretSummary(summary);
      setNewSecretName("");
      setNotice(`Saved ${name} in “${selectedSecretProfile}”.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to save the secret.");
    } finally {
      setNewSecretValue("");
      setSecretBusy(false);
    }
  };

  const deleteSecret = async (name: string) => {
    if (!selectedSecretProfile || !window.confirm(`Remove ${name} from ${selectedSecretProfile}?`)) return;
    setSecretBusy(true);
    try {
      const summary = await api<SecretStoreSummary>(`/api/secrets/profiles/${encodeURIComponent(selectedSecretProfile)}/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
      applySecretSummary(summary);
      setNotice(`Removed ${name}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to remove the secret.");
    } finally {
      setSecretBusy(false);
    }
  };

  const deleteSecretProfile = async () => {
    if (!selectedSecretProfile || !window.confirm(`Delete the local profile ${selectedSecretProfile}?`)) return;
    const profile = selectedSecretProfile;
    setSecretBusy(true);
    try {
      const summary = await api<SecretStoreSummary>(`/api/secrets/profiles/${encodeURIComponent(profile)}`, { method: "DELETE" });
      applySecretSummary(summary);
      setSelectedSecretProfile("");
      setNotice(`Deleted local secret profile “${profile}”.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to delete the secret profile.");
    } finally {
      setSecretBusy(false);
    }
  };

  const launchRun = async (event: FormEvent) => {
    event.preventDefault();
    if (!health.act.available) {
      setShowActHelp(true);
      setNotice(null);
      return;
    }
    if (unsupportedRunners.length) {
      setNotice(`Map ${unsupportedRunners.join(", ")} before running; Act would skip those jobs.`);
      return;
    }
    if (!selectedWorkflows.size) {
      setNotice("Select at least one workflow to start a run.");
      return;
    }
    if (!connected) {
      setNotice("This preview is showing sample data. Launch ActUI from a repository to run workflows.");
      return;
    }
    setIsLaunching(true);
    try {
      const payload: RunRequest = {
        event: selectedEvent,
        workflowIds: [...selectedWorkflows],
        jobSelections: [...selectedJobs].map(parseJobKey),
        concurrency: advanced.concurrency,
        architecture: advanced.architecture || undefined,
        platform: platformMappings(advanced.platform).length ? platformMappings(advanced.platform) : undefined,
        offline: advanced.offline,
        artifacts: advanced.artifacts,
        verbose: advanced.verbose,
        approved: advanced.approved,
        secretProfile: selectedSecretProfile || undefined,
        initiator: { type: "human", name: "Local user" },
      };
      const result = await api<{ run: Run }>("/api/runs", { method: "POST", body: JSON.stringify(payload) });
      setRuns((current) => [result.run, ...current]);
      setActiveRunId(result.run.id);
      setActiveJobKey(result.run.jobs[0] ? jobKey(result.run.jobs[0].workflowId, result.run.jobs[0].id) : "");
      navigateView("runs");
      setNotice(`Run ${result.run.id.slice(0, 8)} started.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to start the run.");
    } finally {
      setIsLaunching(false);
    }
  };

  const cancelRun = async () => {
    if (!activeRun || !connected) return;
    try {
      const result = await api<{ run: Run }>(`/api/runs/${activeRun.id}/cancel`, { method: "POST" });
      setRuns((current) => [result.run, ...current.filter((item) => item.id !== result.run.id)]);
      setNotice("Cancellation requested.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to cancel the run.");
    }
  };

  return (
    <main className="app-shell">
      <a className="skip-link" href="#workspace">Skip to content</a>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="ActUI home">
          <span className="brand-mark" aria-hidden="true"><i /><i /></span>
          <span>Act<span>UI</span></span>
        </a>
        <button className="repo-switcher" type="button" title={`${health.repo} · Open command palette`} onClick={() => setPaletteOpen(true)} aria-label={`Open command palette for ${health.repoName}`}>
          <span className="repo-dot" aria-hidden="true" />
          <span className="repo-owner">local /</span>
          <strong>{health.repoName}</strong>
          <kbd>⌘ K</kbd>
        </button>
        <div className="topbar-actions">
          <div className={`connection ${connected ? "is-live" : ""}`}>
            <span aria-hidden="true" />{connected ? "Local engine" : "Preview mode"}
          </div>
          <button className="icon-button" type="button" aria-label="Open settings" onClick={() => setShowSettings(true)}>⚙</button>
          <a className="avatar" href="https://github.com/nektos/act" target="_blank" rel="noreferrer" aria-label="View Act on GitHub">A</a>
        </div>
      </header>

      <aside className="sidebar" aria-label="Primary navigation">
        <nav>
          <button className={`nav-item ${view === "workflows" ? "active" : ""}`} type="button" onClick={() => navigateView("workflows")}><span aria-hidden="true">⌁</span>Workflows</button>
          <button className={`nav-item ${view === "runs" ? "active" : ""}`} type="button" onClick={() => navigateView("runs")}><span aria-hidden="true">◷</span>Run history</button>
          <button className={`nav-item ${view === "secrets" ? "active" : ""}`} type="button" onClick={() => navigateView("secrets")}><span aria-hidden="true">◇</span>Secrets</button>
          <button className={`nav-item ${view === "environment" ? "active" : ""}`} type="button" onClick={() => navigateView("environment")}><span aria-hidden="true">⬡</span>Environment</button>
          <a className="nav-item" href="/docs"><span aria-hidden="true">?</span>Handbook</a>
        </nav>
        {view === "workflows" ? <div className="sidebar-section">
          <p>Triggers</p>
          {events.map((event) => (
            <button className={selectedEvent === event ? "active" : ""} type="button" key={event} onClick={() => chooseEvent(event)}>
              <span className="event-icon" aria-hidden="true">{event === "pull_request" ? "↗" : event === "push" ? "↑" : event === "schedule" ? "◷" : "▶"}</span>
              {EVENT_LABELS[event] ?? event.replaceAll("_", " ")}
              <span className="count">{workflows.filter((workflow) => workflow.triggers.includes(event)).length}</span>
            </button>
          ))}
        </div> : null}
        <div className="engine-card">
          <div><span className={health.act.available ? "ok-dot" : "bad-dot"} aria-hidden="true" /><strong>Act engine</strong></div>
          <p>{health.act.available ? health.act.version?.replace("act version ", "v") : "Not found"}</p>
          {!health.act.available ? <button type="button" onClick={() => setShowActHelp(true)}>Setup Act</button> : null}
          <div><span className={health.docker.available ? "ok-dot" : "bad-dot"} aria-hidden="true" /><strong>Docker</strong></div>
          <p>{health.docker.available ? health.docker.version : "Not available"}</p>
        </div>
        <p className="powered">Powered by <a href="https://github.com/nektos/act" target="_blank" rel="noreferrer">nektos/act</a></p>
      </aside>

      <section className="workspace" id="workspace">
        {view === "workflows" ? <>
        <div className="workspace-heading" id="workflows">
          <div>
            <p className="eyebrow">{EVENT_LABELS[selectedEvent] ?? selectedEvent} workflows</p>
            <h1>Run your CI. Stay in flow.</h1>
            <p>Choose a workflow, tune the event, and watch every job run locally.</p>
          </div>
          <button className="primary-button" type="submit" form="run-form" disabled={isLaunching || selectedWorkflows.size === 0 || health.trusted === false}>
            <span aria-hidden="true">▶</span>{health.trusted === false ? "Read-only session" : !health.act.available ? "Install Act to run" : isLaunching ? "Starting…" : `Run selected (${selectedWorkflows.size})`}
          </button>
        </div>

        {!health.act.available && showActHelp && health.act.installation ? (
          <section className="missing-act-panel" role="alert" aria-labelledby="missing-act-title">
            <div className="missing-act-icon" aria-hidden="true">!</div>
            <div className="missing-act-content">
              <p className="eyebrow">Runner prerequisite</p>
              <h2 id="missing-act-title">Act is missing on {health.act.installation.os}</h2>
              <p>ActUI detected <strong>{health.act.installation.os} · {health.act.installation.architecture}</strong>. Install Act with {health.act.installation.packageManager}, then restart this ActUI session.</p>
              <div className="install-command">
                <code>{health.act.installation.command}</code>
                <button type="button" onClick={async () => {
                  await navigator.clipboard?.writeText(health.act.installation?.command ?? "");
                  setCopiedInstall(true);
                  window.setTimeout(() => setCopiedInstall(false), 1_500);
                }}>{copiedInstall ? "Copied" : "Copy"}</button>
              </div>
              <ol>
                <li>Run the command in your terminal.</li>
                <li>Confirm it with <code>{health.act.installation.verifyCommand}</code>.</li>
                <li>Restart ActUI. If Act is elsewhere, launch with <code>--act-path /absolute/path/to/act</code>.</li>
              </ol>
              <p className="missing-act-links"><a href={health.act.installation.docsUrl} target="_blank" rel="noreferrer">Read the official Act installation guide ↗</a><span>Docker is normally needed for container jobs.</span></p>
            </div>
            <button className="dismiss-panel" type="button" onClick={() => setShowActHelp(false)} aria-label="Dismiss Act installation help">×</button>
          </section>
        ) : null}

        <form id="run-form" className="run-controls" onSubmit={launchRun}>
          <label className="search-field">
            <span className="sr-only">Filter workflows</span>
            <span aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter workflows…" />
            <kbd>/</kbd>
          </label>
          <div className="event-select">
            <span>Event</span>
            <select value={selectedEvent} onChange={(event) => chooseEvent(event.target.value)} aria-label="Workflow event">
              {events.map((event) => <option key={event} value={event}>{EVENT_LABELS[event] ?? event}</option>)}
            </select>
          </div>
          <div className="event-select secret-profile-select">
            <span>Secrets</span>
            <select value={selectedSecretProfile} onChange={(event) => setSelectedSecretProfile(event.target.value)} aria-label="Local secret profile">
              <option value="">No secrets</option>
              {secretProfiles.map((profile) => <option value={profile.name} key={profile.name}>{profile.name} · {profile.secretNames.length}</option>)}
            </select>
          </div>
          <button className="secondary-button" type="button" onClick={() => setShowSettings(true)}><span aria-hidden="true">☷</span> Configure</button>
          <button className="secondary-button command-button" type="button" onClick={() => setShowCommand((value) => !value)}><span aria-hidden="true">›_</span> Command</button>
        </form>

        <section className="job-presets" aria-labelledby="job-lists-title">
          <div className="preset-heading"><div><p className="eyebrow">Repository presets</p><h2 id="job-lists-title">Custom job lists</h2></div><span>{selectedJobs.size} selected</span></div>
          <label><span className="sr-only">Load a saved job list</span><select value={activePresetId} onChange={(event) => applyPreset(event.target.value)}><option value="">Current selection</option>{jobPresets.map((preset) => <option value={preset.id} key={preset.id}>{preset.name}</option>)}</select></label>
          <label className="preset-name"><span className="sr-only">New job list name</span><input value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="List name, e.g. Fast checks" /></label>
          <button className="secondary-button" type="button" onClick={savePreset}>Save list</button>
          {activePresetId ? <button className="preset-delete" type="button" onClick={deletePreset}>Delete</button> : null}
        </section>

        {unsupportedRunners.length ? <section className="runner-mapping-alert" role="alert" aria-labelledby="runner-mapping-title">
          <span aria-hidden="true">🚧</span>
          <div><p className="eyebrow">Runner mapping required</p><h2 id="runner-mapping-title">Act would skip {unsupportedRunners.length === 1 ? unsupportedRunners[0] : `${unsupportedRunners.length} custom platforms`}</h2><p>These are repository-specific runner labels, not built-in Act platforms. Apply a compatible Ubuntu image before starting the run.</p><code>{unsupportedRunners.map(runnerSuggestion).join("\n")}</code><a href="https://nektosact.com/usage/runners.html" target="_blank" rel="noreferrer">Act runner mapping guide ↗</a></div>
          <button className="secondary-button" type="button" onClick={() => setAdvanced((current) => ({ ...current, platform: [...platformMappings(current.platform), ...unsupportedRunners.map(runnerSuggestion)].join(", ") }))}>Apply mappings</button>
        </section> : null}

        {showCommand ? (
          <div className="command-preview" role="status">
            <code>act {selectedEvent} {selectedWorkflows.size === 1 ? `-W .github/workflows/${[...selectedWorkflows][0]}` : ""} {[...selectedJobs].map((key) => `-j ${parseJobKey(key).jobId}`).join(" ")} --json --concurrent-jobs {advanced.concurrency}{platformMappings(advanced.platform).map((mapping) => ` --platform ${mapping}`).join("")}{selectedSecretProfile ? ` --secret-file <local-profile:${selectedSecretProfile}>` : ""}</code>
            <button type="button" onClick={() => navigator.clipboard?.writeText(`act ${selectedEvent} --json --concurrent-jobs ${advanced.concurrency}`)}>Copy</button>
          </div>
        ) : null}

        <div className="workflow-grid">
          {eventWorkflows.length ? eventWorkflows.map((workflow) => {
            const selected = selectedWorkflows.has(workflow.id);
            return (
              <article className={`workflow-card ${selected ? "selected" : ""}`} key={workflow.id}>
                <label className="workflow-select">
                  <input type="checkbox" checked={selected} onChange={() => toggleWorkflow(workflow.id)} />
                  <span className="custom-check" aria-hidden="true">✓</span>
                  <span className="sr-only">Select {workflow.name}</span>
                </label>
                <div className="workflow-card-head">
                  <span className="workflow-glyph" aria-hidden="true">⌘</span>
                  <div><h2>{workflow.name}</h2><code>{workflow.path}</code></div>
                  <button className="menu-button" type="button" aria-label={`More options for ${workflow.name}`}>•••</button>
                </div>
                <div className="trigger-list">{workflow.triggers.map((event) => <TriggerBadge event={event} key={event} />)}</div>
                <div className="workflow-jobs" aria-label={`${workflow.jobs.length} jobs`}>
                  {workflow.jobs.map((job) => {
                    const jobSelected = selectedJobs.has(jobKey(workflow.id, job.id));
                    return <section className={`workflow-job ${jobSelected ? "selected" : ""}`} key={job.id}>
                      <label className="job-select-row">
                        <input type="checkbox" checked={jobSelected} onChange={() => toggleJob(workflow.id, job.id)} />
                        <span className="sr-only">Select job</span>
                        <span><strong>{job.name}</strong><small>{job.runner}{job.needs.length ? ` · after ${job.needs.join(", ")}` : ""}</small></span>
                      </label>
                      <ol className="job-steps">
                        {job.stepDefinitions?.length ? job.stepDefinitions.map((step) => <li key={step.id}><span aria-hidden="true" />{step.name}</li>) : <li><span aria-hidden="true" />{job.steps} configured {job.steps === 1 ? "step" : "steps"}</li>}
                      </ol>
                    </section>;
                  })}
                </div>
                <footer>
                  <span>{workflow.jobs.length} {workflow.jobs.length === 1 ? "job" : "jobs"}</span>
                  <span>{workflow.jobs.reduce((sum, job) => sum + job.steps, 0)} steps</span>
                  <span>{workflow.jobs.some((job) => job.matrix) ? "Matrix" : workflow.jobs[0]?.runner ?? "runner"}</span>
                  {!workflow.valid ? <span className="invalid">Needs attention</span> : null}
                </footer>
              </article>
            );
          }) : <EmptyState title="No workflows here" body="Try another event or clear the workflow filter." />}
        </div>
        </> : null}

        {view === "runs" ? <section className="runs-panel view-panel" id="runs">
          <div className="view-heading">
            <div><p className="eyebrow">Repository activity</p><h1>Run history</h1><p>Inspect every retained local run, its jobs, and complete output.</p></div>
          </div>
          <div className="section-heading">
            <div><p className="eyebrow">Select a run</p><h2>{runs.length} retained {runs.length === 1 ? "run" : "runs"}</h2></div>
            <div className="run-tabs" role="tablist" aria-label="Recent runs">
              {runs.map((run) => (
                <button type="button" role="tab" aria-selected={run.id === activeRun?.id} className={run.id === activeRun?.id ? "active" : ""} key={run.id} onClick={() => setActiveRunId(run.id)}>
                  <StatusMark status={run.status} />{run.event.replaceAll("_", " ")} · {ago(run.createdAt, now)}
                </button>
              ))}
            </div>
          </div>

          {activeRun ? (
            <div className={`console-shell ${consoleFullscreen ? "console-fullscreen" : ""}`}>
              <div className="run-summary">
                <div className="run-title">
                  <StatusMark status={activeRun.status} />
                  <div><h3>{STATUS_LABELS[activeRun.status]} · {EVENT_LABELS[activeRun.event] ?? activeRun.event}</h3><p>Run {activeRun.id.slice(0, 8)} · {formatDuration(activeRun.startedAt, activeRun.completedAt, now)}</p></div>
                </div>
                <div className="run-summary-actions">
                  <button className="expand-console" type="button" onClick={() => setConsoleFullscreen((value) => !value)} aria-pressed={consoleFullscreen}>{consoleFullscreen ? "Exit full view" : "Full viewport"}</button>
                  {["running", "queued", "blocked"].includes(activeRun.status) ? <button className="cancel-button" type="button" onClick={cancelRun}>Cancel run</button> : null}
                </div>
              </div>
              {activeRun.agent?.connected || activeRun.agent?.notes.length ? (
                <div className="agent-strip">
                  <div className="agent-identity"><span aria-hidden="true">✦</span><div><strong>{activeRun.agent.name ?? activeRun.initiator?.name ?? "Coding agent"}</strong><small>Connected agent · {activeRun.agent.phase ?? "waiting"}</small></div></div>
                  <span className="attempt-chip">Attempt {activeRun.agent.attempt} / {activeRun.agent.maxAttempts}</span>
                  {activeRun.agent.filesChanged.length ? <details><summary>{activeRun.agent.filesChanged.length} files changed</summary><ul>{activeRun.agent.filesChanged.map((file) => <li key={file}><code>{file}</code></li>)}</ul></details> : null}
                  {activeRun.agent.notes.at(-1) ? <p className="agent-note"><strong>{activeRun.agent.notes.at(-1)?.author}:</strong> {activeRun.agent.notes.at(-1)?.body}</p> : <p className="agent-note">Agent activity and decisions will appear here for the shared run.</p>}
                  {["running", "queued", "blocked"].includes(activeRun.status) ? <button type="button" onClick={cancelRun}>Stop</button> : null}
                </div>
              ) : null}
              <div className="console-layout">
                <div className="job-list" role="tablist" aria-label="Run jobs">
                  <div className="console-job-tab">
                    <button id="run-output-tab" type="button" role="tab" aria-selected={runOutputSelected} aria-controls="active-job-panel" className={runOutputSelected ? "active" : ""} onClick={() => setActiveJobKey(RUN_OUTPUT_KEY)}>
                      <StatusMark status={activeRun.status} />
                      <span><strong>Run output</strong><small>{activeRun.logs.filter((entry) => !entry.jobId).length} process-level messages</small></span>
                      <span aria-hidden="true">›</span>
                    </button>
                  </div>
                  {activeRun.jobs.length ? activeRun.jobs.map((job, index) => {
                    const selected = activeJob?.id === job.id && activeJob.workflowId === job.workflowId;
                    return <div className="console-job-tab" key={`${job.workflowId}-${job.id}`}>
                      <button id={`job-tab-${index}`} type="button" role="tab" aria-selected={selected} aria-controls="active-job-panel" className={selected ? "active" : ""} onClick={() => setActiveJobKey(jobKey(job.workflowId, job.id))}>
                        <StatusMark status={job.status} />
                        <span><strong>{job.name}</strong><small>{job.runner} · {job.steps} {job.steps === 1 ? "step" : "steps"} · {formatDuration(job.startedAt, job.completedAt, now)}</small></span>
                        <span aria-hidden="true">›</span>
                      </button>
                    </div>;
                  }) : <p className="job-placeholder">Job details were not retained for this run.</p>}
                </div>
                <div className="logs-pane" id="active-job-panel" role="tabpanel" aria-labelledby={runOutputSelected ? "run-output-tab" : `job-tab-${Math.max(0, activeRun.jobs.findIndex((job) => job.id === activeJob?.id && job.workflowId === activeJob?.workflowId))}`}>
                  {activeJob ? <div className="console-step-group" aria-label={`${activeJob.name} steps`}>
                    <div><span className={`status-mark status-${activeJob.status}`} aria-hidden="true" /><span><strong>{activeJob.name}</strong><small>{activeJob.workflowId}</small></span></div>
                    <ol>{consoleSteps(activeJob).map((step, index) => {
                      const status = consoleStepStatus(activeJob, step.name, index);
                      return <li className={`step-${status}`} key={step.id}><StatusMark status={status} /><span>{step.name}</span><small>{STATUS_LABELS[status]}</small></li>;
                    })}</ol>
                  </div> : <div className="run-output-summary"><span aria-hidden="true">›_</span><div><strong>Run output</strong><p>Runner startup, container, cache, artifact, and other process-level messages. Job tabs contain only records attributed to that job.</p></div></div>}
                  <div className="logs-toolbar">
                    <div><span className="live-pulse" aria-hidden="true" />{activeJob?.name ?? "Run output"}</div>
                    <label><span className="sr-only">Search logs</span><input value={logQuery} onChange={(event) => setLogQuery(event.target.value)} placeholder="Search logs" /></label>
                    <button type="button" onClick={() => navigator.clipboard?.writeText(visibleLogs.map((entry) => entry.message).join("\n"))}>Copy</button>
                  </div>
                  <div className="logs" role="log" aria-live="polite" aria-label="Live workflow logs">
                    {visibleLogs.length ? visibleLogs.map((entry: LogEntry) => (
                      <div className={`log-line log-${entry.level}`} key={entry.id}>
                        <time dateTime={entry.time}>{clockTime(entry.time)}</time>
                        <span>{entry.message}</span>
                      </div>
                    )) : <p className="no-logs">No matching log lines.</p>}
                    {activeRun.status === "running" ? <span className="log-cursor" aria-hidden="true" /> : null}
                  </div>
                </div>
              </div>
            </div>
          ) : <EmptyState title="No runs yet" body="Select a workflow above to start your first local run." />}
        </section> : null}

        {view === "secrets" ? <section className="secrets-view view-panel" id="secrets">
          <div className="view-heading">
            <div><p className="eyebrow">Local plaintext profiles</p><h1>Secrets</h1><p>Keep repository-specific values in private <code>.env</code> files outside the checkout, then select a profile when starting a run.</p></div>
          </div>
          <div className="secrets-layout">
            <aside className="secret-profiles" aria-label="Local secret profiles">
              <div><p className="eyebrow">Profiles</p><strong>{secretProfiles.length} local</strong></div>
              <div className="secret-profile-list">
                {secretProfiles.map((profile) => <button className={selectedSecretProfile === profile.name ? "active" : ""} type="button" key={profile.name} onClick={() => setSelectedSecretProfile(profile.name)}>
                  <span><strong>{profile.name}</strong><small>{profile.secretNames.length} {profile.secretNames.length === 1 ? "secret" : "secrets"}</small></span><span aria-hidden="true">›</span>
                </button>)}
                {!secretProfiles.length ? <p>No profiles yet.</p> : null}
              </div>
              <form className="new-profile-form" onSubmit={createSecretProfile}>
                <label><span>New profile</span><input value={newProfileName} onChange={(event) => setNewProfileName(event.target.value)} placeholder="local or staging" autoComplete="off" /></label>
                <button className="secondary-button" type="submit" disabled={secretBusy}>Create</button>
              </form>
            </aside>

            <div className="secret-profile-panel">
              {activeSecretProfile ? <>
                <header><div><p className="eyebrow">Selected profile</p><h2>{activeSecretProfile.name}</h2><p>Values are never returned by the API. Saving the same name replaces its local value.</p></div><button className="danger-button" type="button" onClick={deleteSecretProfile} disabled={secretBusy}>Delete profile</button></header>
                <div className="secret-name-list">
                  {activeSecretProfile.secretNames.map((name) => <div key={name}><span aria-hidden="true">●●●●</span><code>{name}</code><button type="button" onClick={() => deleteSecret(name)} disabled={secretBusy}>Remove</button></div>)}
                  {!activeSecretProfile.secretNames.length ? <EmptyState title="This profile is empty" body="Add the first name and value below." /> : null}
                </div>
                <form className="secret-entry-form" onSubmit={saveSecret}>
                  <label><span>Secret name</span><input value={newSecretName} onChange={(event) => setNewSecretName(event.target.value.toUpperCase())} placeholder="API_TOKEN" autoCapitalize="characters" autoComplete="off" spellCheck={false} /></label>
                  <label><span>Secret value</span><input type="password" value={newSecretValue} onChange={(event) => setNewSecretValue(event.target.value)} placeholder="Stored only on this machine" autoComplete="new-password" spellCheck={false} /></label>
                  <button className="primary-button" type="submit" disabled={secretBusy || !newSecretName.trim()}>Save secret</button>
                </form>
              </> : <EmptyState title="Select or create a profile" body="Profiles group local values for a repository and can be attached to a workflow run." />}
            </div>
          </div>
          <div className="environment-note secret-storage-note"><strong>Plaintext at rest</strong><p>Profiles are mode-0600 files under <code>{secretStoragePath || "the ActUI configuration directory"}</code>. They stay outside Git, browser storage, run history, and API responses. Anyone with access to your operating-system account may still read them.</p></div>
        </section> : null}

        {view === "environment" ? <section className="environment-view view-panel" id="environment">
          <div className="view-heading"><div><p className="eyebrow">Local execution</p><h1>Environment</h1><p>Review the tools, trust boundary, and repository context used by every ActUI run.</p></div><button className="secondary-button" type="button" onClick={() => setShowSettings(true)}>Runner settings</button></div>
          <div className="environment-grid">
            <article><span className={health.act.available ? "ok-dot" : "bad-dot"} aria-hidden="true" /><div><p>Execution engine</p><h2>Act</h2><code>{health.act.available ? health.act.version : "Not installed"}</code>{!health.act.available ? <button type="button" onClick={() => { setShowActHelp(true); navigateView("workflows"); }}>Installation help</button> : null}</div></article>
            <article><span className={health.docker.available ? "ok-dot" : "bad-dot"} aria-hidden="true" /><div><p>Container engine</p><h2>Docker</h2><code>{health.docker.available ? health.docker.version : "Not available"}</code></div></article>
            <article><span className="ok-dot" aria-hidden="true" /><div><p>Repository</p><h2>{health.repoName}</h2><code title={health.repo}>{health.repo}</code></div></article>
            <article><span className={health.trusted ? "ok-dot" : "bad-dot"} aria-hidden="true" /><div><p>Execution trust</p><h2>{health.trusted ? "Trusted" : "Read-only"}</h2><span>{health.trusted ? "Workflow execution is enabled for this session." : "Restart with --trust after reviewing workflows."}</span></div></article>
          </div>
          <div className="environment-note"><strong>Local by design</strong><p>The control plane listens on loopback and requires this session’s random token. Run history stays in the operating-system cache; job-list preferences stay in browser storage under this repository path.</p></div>
        </section> : null}
      </section>

      {paletteOpen ? (
        <div className="palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPaletteOpen(false); }}>
          <section className="command-palette" role="dialog" aria-modal="true" aria-labelledby="palette-title">
            <header><span aria-hidden="true">⌕</span><label><span className="sr-only" id="palette-title">Command palette</span><input ref={paletteInputRef} value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} placeholder="Go to a view…" /></label><kbd>Esc</kbd></header>
            <div className="palette-results">
              {([
                { id: "workflows" as const, icon: "⌁", label: "Workflows", detail: "Select workflows, jobs, and saved lists" },
                { id: "runs" as const, icon: "◷", label: "Run history", detail: "Inspect retained runs and live logs" },
                { id: "secrets" as const, icon: "◇", label: "Secrets", detail: "Manage local plaintext profiles" },
                { id: "environment" as const, icon: "⬡", label: "Environment", detail: "Review Act, Docker, trust, and repository" },
              ]).filter((command) => `${command.label} ${command.detail}`.toLowerCase().includes(paletteQuery.toLowerCase())).map((command) => (
                <button type="button" key={command.id} onClick={() => navigateView(command.id)}>
                  <span aria-hidden="true">{command.icon}</span><span><strong>{command.label}</strong><small>{command.detail}</small></span>{view === command.id ? <em>Current</em> : <span aria-hidden="true">↵</span>}
                </button>
              ))}
            </div>
            <footer><span><kbd>⌘</kbd><kbd>K</kbd> toggle</span><span>Repository: <strong>{health.repoName}</strong></span></footer>
          </section>
        </div>
      ) : null}

      {showSettings ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSettings(false); }}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <header><div><p className="eyebrow">Run configuration</p><h2 id="settings-title">Tune the local runner</h2></div><button className="icon-button" type="button" onClick={() => setShowSettings(false)} aria-label="Close settings">×</button></header>
            <div className="settings-grid">
              <label><span>Concurrent jobs</span><input type="number" min="1" max="64" value={advanced.concurrency} onChange={(event) => setAdvanced((current) => ({ ...current, concurrency: Number(event.target.value) }))} /><small>Act defaults to available CPU cores.</small></label>
              <label><span>Container architecture</span><select value={advanced.architecture} onChange={(event) => setAdvanced((current) => ({ ...current, architecture: event.target.value }))}><option value="">Host default</option><option value="linux/amd64">Linux AMD64</option><option value="linux/arm64">Linux ARM64</option></select><small>Useful on Apple Silicon.</small></label>
              <label><span>Runner mappings</span><input type="text" placeholder="ubuntu-custom=image, other=image" value={advanced.platform} onChange={(event) => setAdvanced((current) => ({ ...current, platform: event.target.value }))} /><small>Separate mappings with commas. Use <code>self-hosted=-self-hosted</code> to run directly on the host.</small></label>
              <label className="toggle-row"><span><strong>Offline mode</strong><small>Prefer cached actions and images.</small></span><input aria-label="Enable offline mode" type="checkbox" checked={advanced.offline} onChange={(event) => setAdvanced((current) => ({ ...current, offline: event.target.checked }))} /></label>
              <label className="toggle-row"><span><strong>Local artifacts</strong><small>Capture uploaded artifacts for this run.</small></span><input aria-label="Capture local artifacts" type="checkbox" checked={advanced.artifacts} onChange={(event) => setAdvanced((current) => ({ ...current, artifacts: event.target.checked }))} /></label>
              <label className="toggle-row"><span><strong>Verbose logs</strong><small>Include Act debug output in the stream.</small></span><input aria-label="Enable verbose logs" type="checkbox" checked={advanced.verbose} onChange={(event) => setAdvanced((current) => ({ ...current, verbose: event.target.checked }))} /></label>
              <label className="toggle-row approval-row"><span><strong>Approve protected jobs</strong><small>Required when ActUI detects deployment, publishing, production, or privileged commands. Review the command preview first.</small></span><input aria-label="Approve protected jobs" type="checkbox" checked={advanced.approved} onChange={(event) => setAdvanced((current) => ({ ...current, approved: event.target.checked }))} /></label>
            </div>
            <div className="settings-note"><span aria-hidden="true">i</span><p>{health.trusted === false ? "This repository is read-only. Restart ActUI with --trust after reviewing its workflows to enable runs. " : ""}Selected local profiles are resolved only when a run starts, kept out of command history, and never returned by the API.</p></div>
            <footer><button className="secondary-button" type="button" onClick={() => setShowSettings(false)}>Cancel</button><button className="primary-button" type="button" onClick={() => setShowSettings(false)}>Save configuration</button></footer>
          </section>
        </div>
      ) : null}

      {notice ? <div className="toast" role="status"><span>{notice}</span><button type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}>×</button></div> : null}
    </main>
  );
}
