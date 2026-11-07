<p align="center">
  <picture>
    <source srcset="./packages/frontend/src/brand/forgeflow-logo-dark.svg" media="(prefers-color-scheme: dark)">
    <img src="./packages/frontend/src/brand/forgeflow-logo-light.svg" alt="Forgeflow" width="320">
  </picture>
</p>

<p align="center"><strong>Agents and workflows, side by side.</strong></p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D22.14-green.svg?style=flat-square" alt="Node.js >= 22.14"></a>
</p>

Forgeflow is a self-hostable platform for building AI agents and deterministic workflows, and for choosing the right one for each job.

Some work needs judgment: reading messy input, researching, triaging. That's what agents are for. Most work is predictable: sync this, check that, route this webhook. That's what workflows are for: cheaper, faster, and every step is auditable. Forgeflow gives you both, and lets you put an agent step inside a workflow for the one part that needs judgment.

## Highlights

### Home and the advisor

- One entry point to two spaces, **Agents** and **Workflows**, each with its own menu.
- An **advisor chat**: describe what you want to automate in your own words. It recommends an agent or a workflow, explains why, and drafts it for you to review and save.

### Agents

- Chat with agents, and build your own with instructions, models, MCP servers, and skills.
- Session history, schedules, and sandboxed environments for running code.

### Workflows (n8n-style)

- **Visual editor**: trigger nodes on the canvas, a searchable step picker, a **+** on every output, and a one-click **Execute workflow** with live step status and per-step output.
- **17 step types**:
  - Core: HTTP request, Edit fields, Agent
  - Flow: If, Switch, Merge, Wait, Stop and error, No operation
  - Data: Filter, Sort, Limit, Remove duplicates, Split out, Aggregate, Date & time, Crypto
- **Multiple triggers** per workflow: manual, any number of schedules (cron), and a webhook.
- Templates such as `{{ trigger.body.email }}` and `{{ nodes.fetch.output.status }}` pass data between steps.
- **Run history** for each workflow and across all workflows.
- **Import and export** in Forgeflow JSON (an exact copy) or **n8n JSON**: bring workflows over from n8n, send them back, or paste workflow JSON straight onto the canvas.

## Quick start

Requirements: Node.js 22.14 or later, and pnpm through Corepack.

```bash
git clone git@github.com:vbrunotech/forgeflow.git
cd forgeflow
nvm use                     # Node version from .nvmrc
corepack enable             # pnpm version pinned in package.json
pnpm install
cp packages/trueforge/.env.example packages/trueforge/.env
pnpm standalone:dev         # SQLite, no other services needed
```

Open http://localhost:3000. To use another port, run `FRONTEND_PORT=3003 pnpm standalone:dev`. The API listens on http://localhost:8790.

Add a model provider in **Settings** to start chatting and to enable the advisor.

For Postgres and Redis (multi-replica), run `pnpm dev:infra` in one terminal and `pnpm dev` in another.

## Project layout

| Package                         | What it is                                                   |
| ------------------------------- | ------------------------------------------------------------ |
| `packages/trueforge`            | API server: agents, sessions, the workflow engine, schedules |
| `packages/trueforge-core`       | Agent runtime core                                           |
| `packages/trueforge-ui`         | React UI library: Home, Agents, the Workflows editor         |
| `packages/frontend`             | The Forgeflow web app                                        |
| `packages/assistant-ui-runtime` | Chat runtime and shared server types                         |
| `packages/trueforge-sdk`        | Generated TypeScript SDK                                     |

Guides for workflows and Home live in [`docs/workflows.mdx`](./docs/workflows.mdx) and [`docs/hub.mdx`](./docs/hub.mdx).

## Status

Forgeflow is under active development. Planned next: a sandboxed **Code** step, app integrations (Slack, email, GitHub…) with a credentials store, and loops over list items.

## Contributing

Issues and pull requests are welcome at [github.com/vbrunotech/forgeflow](https://github.com/vbrunotech/forgeflow/issues). See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the development setup and checks.

## Credits and license

Forgeflow is built on [TrueForge](https://github.com/truefoundry/trueforge) by TrueFoundry, the open-source agent harness. It is released under the MIT License; see [`LICENSE`](./LICENSE), which keeps the original copyright notice.
