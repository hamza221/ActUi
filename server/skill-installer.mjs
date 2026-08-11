import { access, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SKILL_NAME = "actui-test-and-fix";
export const SKILL_TARGETS = ["auto", "codex", "claude", "agent-skills"];

const TARGETS = {
  codex: {
    environmentVariable: "CODEX_HOME",
    configDirectory: ".codex",
    skillsDirectory: "skills",
  },
  claude: {
    environmentVariable: "CLAUDE_CONFIG_DIR",
    configDirectory: ".claude",
    skillsDirectory: "skills",
  },
  "agent-skills": {
    environmentVariable: "AGENT_SKILLS_HOME",
    configDirectory: ".agents",
    skillsDirectory: "skills",
  },
};

async function pathExists(candidate, exists = async (value) => {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}) {
  return exists(candidate);
}

function targetSkillsRoot(target, { env, home }) {
  const adapter = TARGETS[target];
  const configuredRoot = env[adapter.environmentVariable];
  if (configuredRoot) {
    return target === "agent-skills"
      ? path.resolve(configuredRoot)
      : path.resolve(configuredRoot, adapter.skillsDirectory);
  }
  return path.join(home, adapter.configDirectory, adapter.skillsDirectory);
}

async function detectTarget({ env, home, exists }) {
  const environmentMatches = Object.entries(TARGETS)
    .filter(([, adapter]) => Boolean(env[adapter.environmentVariable]))
    .map(([target]) => target);

  if (environmentMatches.length === 1) return { target: environmentMatches[0], detectedBy: "environment" };
  if (environmentMatches.length > 1) {
    throw new Error(`Multiple skill targets are configured (${environmentMatches.join(", ")}). Pass --target explicitly.`);
  }

  const directoryMatches = [];
  for (const [target, adapter] of Object.entries(TARGETS)) {
    const configRoot = path.join(home, adapter.configDirectory);
    if (await pathExists(configRoot, exists)) directoryMatches.push(target);
  }

  if (directoryMatches.length === 1) return { target: directoryMatches[0], detectedBy: "existing-directory" };
  if (directoryMatches.length > 1) {
    throw new Error(`Multiple skill targets were detected (${directoryMatches.join(", ")}). Pass --target explicitly.`);
  }
  throw new Error(`No supported skill target was detected. Pass --target ${Object.keys(TARGETS).join("|")} or --destination /path/to/skills.`);
}

export async function resolveSkillInstallation({
  target = "codex",
  destination,
  env = process.env,
  home = os.homedir(),
  exists,
} = {}) {
  if (!SKILL_TARGETS.includes(target)) {
    throw new Error(`Unsupported skill target "${target}". Expected one of: ${SKILL_TARGETS.join(", ")}.`);
  }

  if (destination) {
    const resolvedTarget = target === "auto" ? "custom" : target;
    return {
      target: resolvedTarget,
      detectedBy: "destination",
      skillsRoot: path.resolve(destination),
      destination: path.resolve(destination, SKILL_NAME),
    };
  }

  const resolved = target === "auto"
    ? await detectTarget({ env, home, exists })
    : { target, detectedBy: "explicit" };
  const skillsRoot = targetSkillsRoot(resolved.target, { env, home });
  return {
    ...resolved,
    skillsRoot,
    destination: path.join(skillsRoot, SKILL_NAME),
  };
}

export async function installSkill({ source, dryRun = false, ...options }) {
  const installation = await resolveSkillInstallation(options);
  if (!dryRun) await cp(source, installation.destination, { recursive: true, force: true });
  return {
    installed: !dryRun,
    dryRun,
    skill: SKILL_NAME,
    ...installation,
  };
}
