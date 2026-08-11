import crypto from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SECRET_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function configRoot() {
  if (process.env.ACTUI_CONFIG_HOME) return path.resolve(process.env.ACTUI_CONFIG_HOME);
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "actui");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "ActUI");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "ActUI");
  return path.join(os.homedir(), ".config", "actui");
}

function validProfile(name) {
  const value = String(name ?? "").trim();
  if (!PROFILE_PATTERN.test(value)) throw new Error("Profile names must be 1-64 characters using letters, numbers, dots, dashes, or underscores.");
  return value;
}

function validSecretName(name) {
  const value = String(name ?? "").trim();
  if (!SECRET_PATTERN.test(value)) throw new Error("Secret names must use environment-variable syntax, such as API_TOKEN.");
  return value;
}

export function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("Invalid .env entry. Expected NAME=value.");
    const name = validSecretName(line.slice(0, separator));
    const source = line.slice(separator + 1).trim();
    let value = source;
    if (source.startsWith('"')) {
      try { value = JSON.parse(source); } catch { throw new Error(`Invalid quoted value for ${name}.`); }
    } else if (source.startsWith("'") && source.endsWith("'")) value = source.slice(1, -1);
    values[name] = String(value);
  }
  return values;
}

export function serializeEnv(values) {
  return `${Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${validSecretName(name)}=${JSON.stringify(String(value))}`)
    .join("\n")}\n`;
}

export class LocalSecretStore {
  constructor(repo, { root } = {}) {
    const repositoryKey = crypto.createHash("sha256").update(path.resolve(repo)).digest("hex").slice(0, 20);
    this.directory = path.join(root ? path.resolve(root) : configRoot(), "secrets", repositoryKey);
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("The local secret directory must be a regular directory, not a link.");
    await chmod(this.directory, 0o700);
  }

  profilePath(profile) {
    return path.join(this.directory, `${validProfile(profile)}.env`);
  }

  async assertSafeFile(file) {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Secret profiles must be regular local files, not links.");
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("Secret profiles must not be accessible by group or other users.");
    return metadata;
  }

  async listProfiles() {
    await this.initialize();
    const entries = await readdir(this.directory, { withFileTypes: true });
    const profiles = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".env")) continue;
      const name = entry.name.slice(0, -4);
      if (!PROFILE_PATTERN.test(name)) continue;
      const file = this.profilePath(name);
      await this.assertSafeFile(file);
      const [contents, metadata] = await Promise.all([readFile(file, "utf8"), stat(file)]);
      profiles.push({ name, secretNames: Object.keys(parseEnv(contents)).sort(), updatedAt: metadata.mtime.toISOString() });
    }
    return profiles.sort((left, right) => left.name.localeCompare(right.name));
  }

  async createProfile(profile) {
    await this.initialize();
    const name = validProfile(profile);
    await writeFile(this.profilePath(name), "", { mode: 0o600, flag: "wx" });
    return { name, secretNames: [] };
  }

  async readProfile(profile) {
    const file = this.profilePath(profile);
    await this.assertSafeFile(file);
    return parseEnv(await readFile(file, "utf8"));
  }

  async writeProfile(profile, values) {
    const file = this.profilePath(profile);
    await this.assertSafeFile(file);
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, serializeEnv(values), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
      await chmod(file, 0o600);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async setSecret(profile, secretName, secretValue) {
    const name = validSecretName(secretName);
    const value = String(secretValue ?? "");
    if (Buffer.byteLength(value) > 262_144) throw new Error("Secret values must be 256 KB or smaller.");
    const values = await this.readProfile(profile);
    values[name] = value;
    await this.writeProfile(profile, values);
    return { name };
  }

  async deleteSecret(profile, secretName) {
    const name = validSecretName(secretName);
    const values = await this.readProfile(profile);
    if (!(name in values)) throw new Error(`Secret ${name} does not exist in this profile.`);
    delete values[name];
    await this.writeProfile(profile, values);
  }

  async deleteProfile(profile) {
    const file = this.profilePath(profile);
    await this.assertSafeFile(file);
    await unlink(file);
  }

  async summary() {
    return { storagePath: this.directory, profiles: await this.listProfiles() };
  }
}
