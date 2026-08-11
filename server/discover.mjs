import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";

const WORKFLOW_EXTENSIONS = new Set([".yml", ".yaml"]);

function stringValue(value, fallback = "") {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (value == null) return fallback;
  return JSON.stringify(value);
}

function normalizeTriggers(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.map(String);
  if (value && typeof value === "object") return Object.keys(value);
  return [];
}

function normalizeNeeds(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.map(String);
  return [];
}

function workflowId(root, file) {
  return path.relative(path.join(root, ".github", "workflows"), file).split(path.sep).join("/");
}

export async function discoverWorkflows(repo) {
  const root = path.join(repo, ".github", "workflows");
  let entries = [];
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = entries
    .filter((entry) => entry.isFile() && WORKFLOW_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(entry.parentPath ?? entry.path ?? root, entry.name))
    .sort();

  return Promise.all(files.map(async (file) => {
    const id = workflowId(repo, file);
    try {
      const source = await readFile(file, "utf8");
      const document = parseDocument(source, { prettyErrors: true, uniqueKeys: true });
      if (document.errors.length) throw document.errors[0];
      const data = document.toJS() ?? {};
      const jobs = Object.entries(data.jobs ?? {}).map(([jobId, rawJob]) => {
        const job = rawJob && typeof rawJob === "object" ? rawJob : {};
        const steps = Array.isArray(job.steps) ? job.steps.map((step, index) => ({
          id: String(step?.id ?? `step-${index + 1}`),
          name: stringValue(step?.name, step?.uses ?? step?.run?.split("\n")[0] ?? `Step ${index + 1}`),
          uses: stringValue(step?.uses),
        })) : [];
        const riskText = JSON.stringify({ id: jobId, name: job.name, steps: job.steps }).toLowerCase();
        const environmentText = JSON.stringify(job.environment ?? "").toLowerCase();
        return {
          id: jobId,
          name: stringValue(job.name, jobId),
          needs: normalizeNeeds(job.needs),
          runner: stringValue(job["runs-on"], "unspecified"),
          steps: steps.length || (job.uses ? 1 : 0),
          stepDefinitions: steps,
          requiresApproval: /deploy|publish|release|privileged|kubectl|terraform apply|npm publish|docker push/.test(riskText) || environmentText.includes("production"),
          ...(job.strategy?.matrix ? { matrix: job.strategy.matrix } : {}),
        };
      });
      return {
        id,
        name: stringValue(data.name, id.replace(/\.ya?ml$/i, "")),
        path: `.github/workflows/${id}`,
        absolutePath: file,
        triggers: normalizeTriggers(data.on),
        jobs,
        valid: true,
      };
    } catch (error) {
      return {
        id,
        name: id,
        path: `.github/workflows/${id}`,
        absolutePath: file,
        triggers: [],
        jobs: [],
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

export function publicWorkflow(workflow) {
  const publicValue = { ...workflow };
  delete publicValue.absolutePath;
  return publicValue;
}
