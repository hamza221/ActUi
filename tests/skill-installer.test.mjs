import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installSkill, resolveSkillInstallation } from "../server/skill-installer.mjs";

test("preserves the Codex install location by default", async () => {
  const result = await resolveSkillInstallation({
    env: { CODEX_HOME: "/configured/codex" },
    home: "/home/agent",
  });
  assert.equal(result.target, "codex");
  assert.equal(result.destination, path.resolve("/configured/codex/skills/actui-test-and-fix"));
});

test("resolves Claude and generic Agent Skills targets", async () => {
  const claude = await resolveSkillInstallation({ target: "claude", env: {}, home: "/home/agent" });
  const agentSkills = await resolveSkillInstallation({ target: "agent-skills", env: {}, home: "/home/agent" });
  assert.equal(claude.destination, path.resolve("/home/agent/.claude/skills/actui-test-and-fix"));
  assert.equal(agentSkills.destination, path.resolve("/home/agent/.agents/skills/actui-test-and-fix"));
});

test("auto-detects one configured harness and rejects ambiguous environments", async () => {
  const detected = await resolveSkillInstallation({
    target: "auto",
    env: { CLAUDE_CONFIG_DIR: "/configured/claude" },
    home: "/home/agent",
  });
  assert.equal(detected.target, "claude");
  assert.equal(detected.detectedBy, "environment");

  await assert.rejects(
    resolveSkillInstallation({
      target: "auto",
      env: { CODEX_HOME: "/codex", CLAUDE_CONFIG_DIR: "/claude" },
      home: "/home/agent",
    }),
    /Multiple skill targets are configured/,
  );
});

test("an explicit destination works for any harness", async () => {
  const result = await resolveSkillInstallation({ target: "auto", destination: "/custom/skills" });
  assert.equal(result.target, "custom");
  assert.equal(result.destination, path.resolve("/custom/skills/actui-test-and-fix"));
});

test("copies the complete skill bundle and supports dry runs", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "actui-skill-installer-"));
  const source = path.resolve("skills/actui-test-and-fix");
  try {
    const dryRunRoot = path.join(temporary, "dry-run");
    const dryRun = await installSkill({ source, destination: dryRunRoot, dryRun: true });
    assert.equal(dryRun.installed, false);
    await assert.rejects(access(dryRun.destination));

    const skillsRoot = path.join(temporary, "skills");
    const installed = await installSkill({ source, destination: skillsRoot });
    assert.equal(installed.installed, true);
    assert.match(await readFile(path.join(installed.destination, "SKILL.md"), "utf8"), /ActUI test and fix/);
    await access(path.join(installed.destination, "references", "event-schema.md"));
    await access(path.join(installed.destination, "agents", "openai.yaml"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
