import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function resolveDockerHost(dockerPath) {
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
  if (!dockerPath) return undefined;
  try {
    const { stdout } = await execFileAsync(dockerPath, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { timeout: 4_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function repositorySlugFromRemote(remote) {
  const value = String(remote || "").trim();
  const match = value.match(/(?:github\.com[/:])([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export async function resolveGitHubRepository(repo) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, "remote", "get-url", "origin"], { timeout: 4_000 });
    return repositorySlugFromRemote(stdout);
  } catch {
    return undefined;
  }
}
