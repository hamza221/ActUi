import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function sessionPath() {
  const base = process.env.XDG_CACHE_HOME || (process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Caches")
    : path.join(os.homedir(), ".cache"));
  return path.join(base, "actui", "session.json");
}

export async function readSession() {
  try {
    return JSON.parse(await readFile(sessionPath(), "utf8"));
  } catch {
    throw new Error("No running ActUI session was found. Start one with `actui . --trust`.");
  }
}

export async function apiRequest(route, options = {}) {
  const session = options.session ?? await readSession();
  const response = await fetch(`${session.url}${route}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-ActUI-Token": session.token,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `ActUI request failed (${response.status}).`);
  return result;
}
