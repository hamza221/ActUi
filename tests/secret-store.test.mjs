import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalSecretStore, parseEnv, serializeEnv } from "../server/secret-store.mjs";

test("round-trips quoted dotenv values", () => {
  const values = { API_TOKEN: "value with spaces", MULTILINE: "first\nsecond", EMPTY: "" };
  assert.deepEqual(parseEnv(serializeEnv(values)), values);
});

test("stores local profiles privately and lists names without values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "actui-secrets-"));
  try {
    const store = new LocalSecretStore("/tmp/example-repository", { root });
    await store.createProfile("local");
    await store.setSecret("local", "API_TOKEN", "not-returned-by-summary");
    await store.setSecret("local", "DATABASE_URL", "postgres://local");

    const summary = await store.summary();
    assert.deepEqual(summary.profiles.map((profile) => ({ name: profile.name, secretNames: profile.secretNames })), [
      { name: "local", secretNames: ["API_TOKEN", "DATABASE_URL"] },
    ]);
    assert.doesNotMatch(JSON.stringify(summary), /not-returned-by-summary|postgres:\/\/local/);

    const file = store.profilePath("local");
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    assert.match(await readFile(file, "utf8"), /API_TOKEN="not-returned-by-summary"/);
    assert.deepEqual(await store.readProfile("local"), { API_TOKEN: "not-returned-by-summary", DATABASE_URL: "postgres://local" });

    await store.deleteSecret("local", "API_TOKEN");
    assert.deepEqual(await store.readProfile("local"), { DATABASE_URL: "postgres://local" });
    await store.deleteProfile("local");
    assert.deepEqual((await store.summary()).profiles, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsafe profile and secret names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "actui-secrets-"));
  try {
    const store = new LocalSecretStore("/tmp/example-repository", { root });
    await assert.rejects(() => store.createProfile("../escape"), /profile names/i);
    await store.createProfile("local");
    await assert.rejects(() => store.setSecret("local", "BAD-NAME", "value"), /environment-variable syntax/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects profile files that are readable by other users", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "actui-secrets-"));
  try {
    const store = new LocalSecretStore("/tmp/example-repository", { root });
    await store.createProfile("local");
    await chmod(store.profilePath("local"), 0o644);
    await assert.rejects(() => store.readProfile("local"), /group or other users/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
