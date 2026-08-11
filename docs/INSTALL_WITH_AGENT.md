# Install ActUI with an agent

Copy the prompt below into any coding-agent harness. It instructs the agent to install ActUI, its runtime dependencies, and the bundled `actui-test-and-fix` skill using the harness's native skill mechanism when one is available.

```text
Install ActUI and all requirements, including its bundled agent skill.

Repository:
https://github.com/hamza221/ActUi.git

Complete the installation end-to-end:

1. Detect the operating system, architecture, shell, package manager, and current agent harness.
2. Install or verify:
   - Git
   - Node.js 22.13+
   - npm
   - Docker Engine or Docker Desktop
   - nektos/act on PATH
3. Confirm the Docker daemon is running.
4. Clone the ActUI repository into a stable user-owned directory. Do not overwrite an existing checkout without approval.
5. Inside the repository, run:
   npm ci
   npm run build
   npm test
   npm link
6. Verify:
   node --version
   npm --version
   docker --version
   docker info
   act --version
   actui --version

Install the bundled agent skill:

7. Locate:
   skills/actui-test-and-fix/
8. Detect how the current harness installs user-level skills, capabilities, plugins, or instruction packages.
9. Install the complete `actui-test-and-fix` directory into the harness's supported user-level location. Preserve:
   - SKILL.md
   - references/
   - agents/
10. If the harness supports the Agent Skills directory convention, use its configured skills directory.
11. For Codex-compatible environments, `actui install-skill` may be used.
12. If the harness has no skill-installation mechanism:
   - Do not claim the skill was installed.
   - Report the skill's absolute path.
   - Explain how its SKILL.md can be supplied as agent instructions.
13. Verify that the harness can discover or load `actui-test-and-fix`.

Safety:

- Do not use elevated privileges without explaining why and obtaining approval.
- Do not execute repository workflows with `--trust` unless the user explicitly trusts the target repository.
- Do not silently modify global harness configuration.
- Do not expose or infer repository secrets.

Finish with a concise report containing:

- Installed component versions
- ActUI checkout path
- ActUI executable path
- Skill installation path and installation method
- Build and test results
- Whether the harness successfully discovered the skill
- Any remaining manual steps

After installation, explain that ActUI can be started with:

actui /path/to/repository --trust

If Act is outside PATH, use:

actui /path/to/repository --act-path /absolute/path/to/act --trust
```
