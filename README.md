# depot-mcp

A small, read-only [MCP](https://modelcontextprotocol.io) server for the [Depot](https://depot.dev) API.

Depot gives agents a CLI, but no MCP server. This server lets an agent read Depot CI failures, job logs, GitHub Actions jobs on Depot runners, and container builds. The agent does not need the `depot` CLI in its sandbox.

- **Transport:** Streamable HTTP, stateless. One endpoint: `POST /mcp`.
- **Auth:** Each request sends the caller's own Depot API token as `Authorization: Bearer <token>`. The server sends that token to Depot and stores nothing.
- **Scope:** Read-only. No tool can start, cancel, retry or delete anything.

## Tools

### Depot CI

| Tool | Depot RPC | Use |
| --- | --- | --- |
| `ci_list_runs` | `CIService/ListRuns` | Find runs by repo, status, PR, SHA or trigger |
| `ci_get_run` | `CIService/GetRun` | Metadata and status of one run (no jobs or attempts) |
| `ci_list_workflows` | `CIService/ListWorkflows` | Find workflows |
| `ci_get_workflow` | `CIService/GetWorkflow` | A workflow with its jobs |
| `ci_diagnose_failure` | `CIService/GetFailureDiagnosis` | Why a run, workflow, job or attempt failed |
| `ci_get_job_summary` | `CIService/GetJobSummary` | Markdown job summary |
| `ci_get_job_logs` | `CIService/GetJobAttemptLogs` | Job attempt logs, with tail, step, stderr and text filters |
| `ci_list_artifacts` | `CIService/ListArtifacts` | Artifact metadata for a run |

### GitHub Actions on Depot runners

| Tool | Depot RPC | Use |
| --- | --- | --- |
| `gha_list_jobs` | `GithubActionsService/ListGithubActionsJobs` | Find jobs by repo, status, conclusion and time (default: last 24 hours) |
| `gha_get_job` | `GithubActionsService/GetGithubActionsJob` | One job |
| `gha_search_logs` | `GithubActionsService/SearchGithubActionsLogs` | Search log lines |
| `gha_get_log_context` | `GithubActionsService/GetGithubActionsLogContext` | Lines around a search match |
| `gha_list_job_runs` | `GithubActionsService/ListGithubActionsJobRuns` | Past runs of one job, to find flaky tests |
| `gha_get_test_results` | `GithubActionsService/GetGithubActionsTestResultsSummary` | Test results for a job |

### Container builds

| Tool | Depot RPC | Use |
| --- | --- | --- |
| `list_projects` | `core.v1.ProjectService/ListProjects` | Projects in the organization |
| `list_builds` | `core.v1.BuildService/ListBuilds` | Builds for a project |
| `get_build` | `core.v1.BuildService/GetBuild` | One build |
| `get_build_steps` | `build.v1.BuildService/GetBuildSteps` | Build steps, with errors |
| `get_build_step_logs` | `build.v1.BuildService/GetBuildStepLogs` | Logs for one build step |

Typical flow to debug a failed Depot CI run:

1. `ci_list_runs` with `status: ["failed"]`, `repo` and `pr`.
2. `ci_diagnose_failure` with `targetType: "run"` and the run ID.
3. `ci_get_job_logs` with an attempt ID from the diagnosis. Add `stderrOnly` or `contains` to make the output smaller.

`ci_get_run` does not return jobs or attempt IDs. Use `ci_diagnose_failure` or `ci_get_workflow` to get them.

`gha_list_jobs` uses a 24-hour window when you do not set `startAt` or `endAt`. Depot's own default is 30 days, and that can time out on large organizations.

## Known issues

- `gha_search_logs` returns `500 internal` from Depot. A direct call to `api.depot.dev` gives the same error, so the fault is in the Depot API. Because of this, `gha_get_log_context` is not tested: it needs a `lineId` from `gha_search_logs`.
- `get_build_step_logs` can return no lines, also for steps that ran for some seconds. The Depot API itself returns `{}` for these steps. Check `hasLogs` and `error` in `get_build_steps` first.

## Tokens

Use a Depot **organization token** (Organization settings → API tokens). Organization and user tokens can use every tool. Project tokens can use only the container build tools.

If you use a user token and belong to more than one organization, send `X-Depot-Org: <org-id>` as well.

## Run

```sh
pnpm install
pnpm build
pnpm start            # listens on PORT (default 3000)
```

Or with Docker:

```sh
docker build -t depot-mcp .
docker run -p 3000:3000 depot-mcp
```

Environment variables:

| Name | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DEPOT_API_URL` | `https://api.depot.dev` | Depot API base URL |
| `DEPOT_TIMEOUT_MS` | `60000` | Timeout for each Depot API call |

`GET /healthz` returns `{"status":"ok"}`.

Put the server behind TLS when you deploy it. The token goes in a request header.

## Connect a client

Claude Code:

```sh
claude mcp add --transport http depot https://<your-host>/mcp \
  --header "Authorization: Bearer $DEPOT_TOKEN"
```

Any other MCP client that supports Streamable HTTP and custom headers works the same way.

## Development

```sh
pnpm dev          # run with reload
pnpm test         # vitest
pnpm typecheck
pnpm smoke PostHog/posthog   # call the tools on a running server with DEPOT_TOKEN from .env
```

The server calls Depot's Connect RPC API with plain JSON over `fetch`. Request field names come from Depot's protobuf definitions in [depot/proto](https://github.com/depot/proto) and [depot/cli](https://github.com/depot/cli/tree/main/proto/depot/ci/v1).
