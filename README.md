# ActUI

ActUI is a local GitHub Actions workbench for humans and coding agents. It discovers workflows in a repository, delegates their execution to [nektos/act](https://github.com/nektos/act), and presents jobs, dependency state, logs, agent notes, approvals, and cancellation in one browser dashboard.

The dashboard, JSON CLI, and local MCP server use one shared run manager. A human and an agent can therefore watch and operate the same run instead of creating disconnected CI processes.

## Quick start

Prerequisites: Node.js 22+, Docker Engine or Docker Desktop, and [Act](https://nektosact.com/installation/index.html) on `PATH`.

```bash
npm install
npm run build
npm link
actui /path/to/repository --trust
```

ActUI binds to `127.0.0.1`, chooses an available port, and opens the dashboard. The explicit `--trust` flag is required to execute workflow code; without it, the session is read-only.

If Act is missing when a run is requested, ActUI detects the host operating system and shows a copyable installation command in both the terminal and dashboard. After installing, verify with `act --version` and restart ActUI. If the executable is installed outside `PATH`, use `--act-path /absolute/path/to/act`. See the [official Act installation guide](https://nektosact.com/installation/index.html) for package-manager alternatives and prerequisites.

Workflow cards group each job with its ordered steps. Select individual jobs, name the selection, and save it as a custom job list. Lists and the last active list are stored locally under the repository’s absolute path, so opening another repository loads its own presets automatically. Targeted runs pass the selected job IDs to Act; required job dependencies are retained in the shared run view. The run console can expand to the entire viewport and closes with its button or `Escape`.

The dashboard has separate Workflows, Run history, and Environment views. Their URL hashes are bookmarkable. Press `Command-K` on macOS or `Control-K` elsewhere—or select the repository switcher—to open the command palette and move between views without leaving the current session.

Inside a run console, jobs are accessible tabs. Selecting a job opens one panel containing that job’s ordered step states and its filtered live logs, keeping job, steps, and output together.

Process-level Act messages are isolated in a separate **Run output** tab instead of being repeated in every job. ActUI parses both JSON and logfmt Act records to preserve job attribution. Each Act workflow process uses an operating-system-assigned artifact-server port, avoiding collisions when several workflows run together.

Before execution, ActUI checks selected jobs for runner labels Act does not provide by default. Custom Ubuntu labels such as `ubuntu-latest-low` produce a visible mapping prompt and can be mapped in one click to `catthehacker/ubuntu:act-latest`. Multiple mappings are passed as repeated `--platform` arguments. ActUI blocks the run until every detected custom label is mapped, preventing silently skipped jobs.

Useful launch options:

```bash
actui . --no-open
actui . --port 4040 --trust
actui . --act-path /custom/path/to/act --trust
```

## Agent and JSON interfaces

```bash
actui discover . --json
actui run --workflow ci.yml --event pull_request --json
actui wait <run-id> --after-cursor 12 --json
actui get <run-id> --json
actui logs <run-id> --failed --json
actui logs <run-id> --from 200 --to 260 --json
actui cancel <run-id> --json
actui rerun-failed <run-id> --files src/cart.ts,src/cart.test.ts --json
```

`wait` is cursor-based and bounded to 30 seconds. Agents receive concise state changes and fetch selected log ranges only when a failure requires them.

Start the provider-neutral local MCP server with:

```bash
actui mcp
```

`actui mcp` is a stdio protocol server, not an interactive shell. It prints a readiness message to the terminal and then remains open while it waits for an MCP client. Configure the client with command `actui` and arguments `["mcp"]`. Keep `actui . --trust` running in another terminal when the tools need to discover or execute workflows; a manual launch also prints the shared dashboard URL when one is active. Human-readable messages use stderr, leaving stdout exclusively for MCP JSON-RPC traffic.

It exposes `discover_workflows`, `start_run`, `wait_for_run`, `get_run`, `get_failed_steps`, `read_logs`, `cancel_run`, `rerun_failed`, and `open_dashboard`.

Install the bundled Codex workflow skill with:

```bash
actui install-skill
```

The skill follows a constrained discover → run smallest scope → wait → inspect failures → fix only when authorized → rerun failed scope loop.

## Safety model

- Repository trust is explicit for every launched session.
- Agent runs receive no secrets by default.
- Secrets are written only to user-private temporary files and deleted after the run.
- Deployment, publishing, release, production, and privileged jobs are detected and require per-run approval.
- The UI shows the exact Act command preview before execution.
- Run, agent-note, cancellation, and result events enter a local audit trail.
- Agent retry attempts are bounded.
- The HTTP server listens on loopback and requires a random session token.
- Run history is stored in the operating system application cache, not the target repository.

## Documentation

The full handbook is built into ActUI at `/docs`. The wire-level cursor and log-range contract is also documented in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Development

```bash
npm run dev
npm run build
npm test
npm run lint
```

## Pull request QA

Every pull request runs the repository’s `QA` workflow. Its independent required-check candidates are ESLint, unit and integration tests, the production bundle, and a high-severity production dependency audit. All jobs use Node.js 22 and reproducible `npm ci` installs. Superseded runs for the same pull request are cancelled automatically.

Run the same code-quality path locally with:

```bash
npm run qa
```

`npm run dev` displays representative preview data when it is not behind the local ActUI control plane. Running `actui . --trust` uses real repository, Act, Docker, run, and agent state.

## Act attribution

ActUI uses [nektos/act](https://github.com/nektos/act) as its local GitHub Actions execution engine. Act is an independent project distributed under the MIT License. Its required notice is preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

ActUI does not claim complete parity with GitHub-hosted runners. Image contents, hardware, networking, permissions, and unsupported GitHub platform services can differ locally.

## License

ActUI is released under the [MIT License](LICENSE).
