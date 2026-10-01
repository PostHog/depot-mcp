import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { type DepotClient, Services } from "./depot.js";
import { collectLogs, DEFAULT_TAIL } from "./logs.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const CI_RUN_STATUSES = ["queued", "running", "finished", "failed", "cancelled"] as const;
const GHA_JOB_STATUSES = ["queued", "waiting", "running", "finished"] as const;
const GHA_JOB_CONCLUSIONS = ["success", "failure", "cancelled", "skipped", "neutral"] as const;
const DIAGNOSIS_TARGETS = ["run", "workflow", "job", "attempt"] as const;

const repo = z.string().describe('Repository in "owner/name" format');
const pageToken = z.string().optional().describe("nextPageToken from a previous response");
const timeRange = {
  startAt: z.string().optional().describe("Inclusive start time, RFC 3339 (e.g. 2026-01-01T00:00:00Z)"),
  endAt: z.string().optional().describe("Exclusive end time, RFC 3339"),
};
const logFilters = {
  tail: z.number().int().min(1).max(5000).optional().describe(`Return only the last N matching lines (default ${DEFAULT_TAIL})`),
  stepName: z.string().optional().describe("Only lines from steps whose name contains this text (case-insensitive)"),
  contains: z.string().optional().describe("Only lines containing this text (case-insensitive)"),
};

// Drops undefined values so the request body only has fields the caller set.
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function toTimeRange(startAt?: string, endAt?: string) {
  return startAt || endAt ? compact({ startAt, endAt }) : undefined;
}

function enumValues(prefix: string, values: readonly string[] | undefined) {
  return values?.map((v) => `${prefix}_${v.toUpperCase()}`);
}

function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function text(data: string): CallToolResult {
  return { content: [{ type: "text", text: data }] };
}

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

export function registerTools(server: McpServer, client: DepotClient): void {
  // ---- Depot CI ----

  server.registerTool(
    "ci_list_runs",
    {
      title: "List Depot CI runs",
      description:
        "List recent Depot CI runs, newest first. To debug a CI failure: call this with status=[\"failed\"] and repo (plus pr or sha), " +
        "then ci_diagnose_failure on the run, then ci_get_job_logs on a failing attempt. Defaults to running and queued runs when status is empty.",
      inputSchema: {
        repo: repo.optional(),
        status: z.array(z.enum(CI_RUN_STATUSES)).optional().describe("Run statuses to include"),
        sha: z.string().optional().describe("Commit SHA prefix"),
        pr: z.string().optional().describe("Pull request number (repo is required with pr)"),
        trigger: z.string().optional().describe('Run trigger, e.g. "push", "pull_request" or "workflow_dispatch"'),
        pageSize: z.number().int().min(1).max(100).optional().describe("Default 50, max 100"),
        pageToken,
      },
      annotations: READ_ONLY,
    },
    (args) => run(async () => json(await client.call(Services.ci, "ListRuns", compact(args)))),
  );

  server.registerTool(
    "ci_get_run",
    {
      title: "Get Depot CI run",
      description: "Get a Depot CI run with its workflows, jobs and attempts.",
      inputSchema: { runId: z.string() },
      annotations: READ_ONLY,
    },
    (args) => run(async () => json(await client.call(Services.ci, "GetRun", args))),
  );

  server.registerTool(
    "ci_list_workflows",
    {
      title: "List Depot CI workflows",
      description: "List recent Depot CI workflows, newest first.",
      inputSchema: {
        repo: repo.optional(),
        name: z.string().optional().describe("Substring match on workflow name or path"),
        status: z.array(z.string()).optional().describe('Lowercase workflow statuses, e.g. ["failed"]'),
        sha: z.string().optional().describe("Head SHA prefix"),
        pr: z.string().optional().describe("Pull request number"),
        trigger: z.string().optional(),
        pageSize: z.number().int().min(1).max(200).optional().describe("Default 50, max 200"),
      },
      annotations: READ_ONLY,
    },
    (args) => run(async () => json(await client.call(Services.ci, "ListWorkflows", compact(args)))),
  );

  server.registerTool(
    "ci_get_workflow",
    {
      title: "Get Depot CI workflow",
      description: "Get a Depot CI workflow with its jobs.",
      inputSchema: { workflowId: z.string() },
      annotations: READ_ONLY,
    },
    (args) => run(async () => json(await client.call(Services.ci, "GetWorkflow", args))),
  );

  server.registerTool(
    "ci_diagnose_failure",
    {
      title: "Diagnose Depot CI failure",
      description:
        "Get Depot's failure diagnosis for a CI run, workflow, job or attempt: grouped failures, representative failing attempts " +
        "and suggested next steps. This is the best first call to find out why CI failed.",
      inputSchema: {
        targetType: z.enum(DIAGNOSIS_TARGETS),
        targetId: z.string().describe("ID of the run, workflow, job or attempt"),
      },
      annotations: READ_ONLY,
    },
    ({ targetType, targetId }) =>
      run(async () =>
        json(
          await client.call(Services.ci, "GetFailureDiagnosis", {
            targetId,
            targetType: `FAILURE_DIAGNOSIS_TARGET_TYPE_${targetType.toUpperCase()}`,
          }),
        ),
      ),
  );

  server.registerTool(
    "ci_get_job_summary",
    {
      title: "Get Depot CI job summary",
      description: "Get the markdown job summary for a Depot CI job (latest attempt) or a specific attempt.",
      inputSchema: {
        jobId: z.string().optional(),
        attemptId: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      run(async () => {
        if (!args.jobId && !args.attemptId) throw new Error("Set jobId or attemptId");
        return json(await client.call(Services.ci, "GetJobSummary", compact(args)));
      }),
  );

  server.registerTool(
    "ci_get_job_logs",
    {
      title: "Get Depot CI job logs",
      description:
        "Get log lines for a Depot CI job attempt. Pages through the full log and returns the last `tail` lines that match the filters. " +
        "Use stepName, contains or stderrOnly to narrow large logs.",
      inputSchema: {
        attemptId: z.string(),
        ...logFilters,
        stderrOnly: z.boolean().optional().describe("Only stderr lines"),
      },
      annotations: READ_ONLY,
    },
    ({ attemptId, ...filter }) =>
      run(async () => {
        const result = await collectLogs(async (pageToken) => {
          const page = await client.call<{
            lines?: { body?: string; stepName?: string; stepKey?: string; stream?: number }[];
            nextPageToken?: string;
          }>(Services.ci, "GetJobAttemptLogs", compact({ attemptId, pageToken }));
          return {
            entries: (page.lines ?? []).map((line) => ({
              body: line.body ?? "",
              step: line.stepName || line.stepKey,
              stderr: line.stream === 1,
            })),
            nextPageToken: page.nextPageToken,
          };
        }, filter);
        return text(result.text);
      }),
  );

  server.registerTool(
    "ci_list_artifacts",
    {
      title: "List Depot CI artifacts",
      description: "List artifact metadata for a Depot CI run, optionally narrowed to a workflow, job or attempt.",
      inputSchema: {
        runId: z.string(),
        workflowId: z.string().optional(),
        jobId: z.string().optional(),
        attemptId: z.string().optional(),
        pageSize: z.number().int().min(1).max(500).optional().describe("Default 100, max 500"),
        pageToken,
      },
      annotations: READ_ONLY,
    },
    (args) => run(async () => json(await client.call(Services.ci, "ListArtifacts", compact(args)))),
  );

  // ---- GitHub Actions on Depot runners ----

  server.registerTool(
    "gha_list_jobs",
    {
      title: "List GitHub Actions jobs on Depot runners",
      description:
        "List GitHub Actions jobs that ran on Depot runners. To find failures, set conclusions=[\"failure\"]. Default window is the last 30 days.",
      inputSchema: {
        repositories: z.array(z.string()).optional().describe('Repositories in "owner/name" format; empty means all'),
        statuses: z.array(z.enum(GHA_JOB_STATUSES)).optional(),
        conclusions: z.array(z.enum(GHA_JOB_CONCLUSIONS)).optional(),
        runnerLabels: z.array(z.string()).optional(),
        query: z.string().optional().describe("Text matched against job and workflow names, or an exact GitHub job/run ID"),
        ...timeRange,
        pageSize: z.number().int().min(1).max(250).optional().describe("Default 50, max 250"),
        pageToken,
      },
      annotations: READ_ONLY,
    },
    ({ startAt, endAt, statuses, conclusions, ...rest }) =>
      run(async () =>
        json(
          await client.call(
            Services.githubActions,
            "ListGithubActionsJobs",
            compact({
              ...rest,
              statuses: enumValues("GITHUB_ACTIONS_JOB_STATUS", statuses),
              conclusions: enumValues("GITHUB_ACTIONS_JOB_CONCLUSION", conclusions),
              timeRange: toTimeRange(startAt, endAt),
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "gha_get_job",
    {
      title: "Get GitHub Actions job",
      description: "Get one GitHub Actions job that ran on a Depot runner.",
      inputSchema: { repository: repo, jobId: z.string().describe("GitHub job ID from gha_list_jobs") },
      annotations: READ_ONLY,
    },
    (args) => run(async () => json(await client.call(Services.githubActions, "GetGithubActionsJob", args))),
  );

  server.registerTool(
    "gha_search_logs",
    {
      title: "Search GitHub Actions logs",
      description:
        "Search log lines of GitHub Actions jobs on Depot runners, newest first. Default window is the last hour, max 30 days. " +
        "Use gha_get_log_context with a returned lineId to see the lines around a match.",
      inputSchema: {
        query: z.string().describe("Text to match in log lines"),
        repositories: z.array(z.string()).optional(),
        workflows: z.array(z.string()).optional().describe("Workflow names"),
        runnerLabels: z.array(z.string()).optional(),
        ...timeRange,
        pageSize: z.number().int().min(1).max(1000).optional().describe("Default 100, max 1000"),
        pageToken,
      },
      annotations: READ_ONLY,
    },
    ({ query, repositories, workflows, runnerLabels, startAt, endAt, pageSize, pageToken }) =>
      run(async () => {
        const filters = compact({ repositories, workflows, runnerLabels });
        return json(
          await client.call(
            Services.githubActions,
            "SearchGithubActionsLogs",
            compact({
              query,
              timeRange: toTimeRange(startAt, endAt),
              filters: Object.keys(filters).length ? filters : undefined,
              pageSize,
              pageToken,
            }),
          ),
        );
      }),
  );

  server.registerTool(
    "gha_get_log_context",
    {
      title: "Get GitHub Actions log context",
      description: "Get the lines before and after a log line returned by gha_search_logs.",
      inputSchema: {
        lineId: z.string(),
        repository: repo,
        surroundingLineCount: z.number().int().min(1).max(100).optional().describe("Default 5, max 100"),
      },
      annotations: READ_ONLY,
    },
    (args) => run(async () => json(await client.call(Services.githubActions, "GetGithubActionsLogContext", compact(args)))),
  );

  server.registerTool(
    "gha_list_job_runs",
    {
      title: "List runs of a GitHub Actions job",
      description: "List past runs of one GitHub Actions job by display name, to see if a failure is new or flaky.",
      inputSchema: {
        repository: repo,
        jobName: z.string().describe("Job display name from gha_list_jobs"),
        ...timeRange,
        pageSize: z.number().int().min(1).max(250).optional(),
        pageToken,
      },
      annotations: READ_ONLY,
    },
    ({ startAt, endAt, ...rest }) =>
      run(async () =>
        json(
          await client.call(
            Services.githubActions,
            "ListGithubActionsJobRuns",
            compact({ ...rest, timeRange: toTimeRange(startAt, endAt) }),
          ),
        ),
      ),
  );

  server.registerTool(
    "gha_get_test_results",
    {
      title: "Get GitHub Actions test results",
      description: "Get the test results summary (including failed tests) for a GitHub Actions job on a Depot runner.",
      inputSchema: { repository: repo, jobId: z.string() },
      annotations: READ_ONLY,
    },
    (args) => run(async () => json(await client.call(Services.githubActions, "GetGithubActionsTestResultsSummary", args))),
  );

  // ---- Projects and container builds ----

  server.registerTool(
    "list_projects",
    {
      title: "List Depot projects",
      description: "List Depot container build projects in the organization.",
      inputSchema: { pageSize: z.number().int().min(1).max(250).optional(), pageToken },
      annotations: READ_ONLY,
    },
    (args) => run(async () => json(await client.call(Services.project, "ListProjects", compact(args)))),
  );

  server.registerTool(
    "list_builds",
    {
      title: "List Depot builds",
      description: "List container builds for a Depot project, newest first.",
      inputSchema: { projectId: z.string(), pageSize: z.number().int().min(1).optional(), pageToken },
      annotations: READ_ONLY,
    },
    (args) => run(async () => json(await client.call(Services.coreBuild, "ListBuilds", compact(args)))),
  );

  server.registerTool(
    "get_build",
    {
      title: "Get Depot build",
      description: "Get one container build.",
      inputSchema: { buildId: z.string() },
      annotations: READ_ONLY,
    },
    (args) => run(async () => json(await client.call(Services.coreBuild, "GetBuild", args))),
  );

  server.registerTool(
    "get_build_steps",
    {
      title: "Get Depot build steps",
      description: "List the steps of a container build, with errors and cache state. Use a step digest with get_build_step_logs.",
      inputSchema: { projectId: z.string(), buildId: z.string(), pageSize: z.number().int().min(1).optional(), pageToken },
      annotations: READ_ONLY,
    },
    (args) => run(async () => json(await client.call(Services.build, "GetBuildSteps", compact(args)))),
  );

  server.registerTool(
    "get_build_step_logs",
    {
      title: "Get Depot build step logs",
      description: "Get the logs of one container build step. Returns the last `tail` matching lines.",
      inputSchema: {
        projectId: z.string(),
        buildId: z.string(),
        buildStepDigest: z.string().describe("Step digest from get_build_steps"),
        tail: logFilters.tail,
        contains: logFilters.contains,
      },
      annotations: READ_ONLY,
    },
    ({ projectId, buildId, buildStepDigest, ...filter }) =>
      run(async () => {
        const result = await collectLogs(async (pageToken) => {
          const page = await client.call<{ logs?: { message?: string }[]; nextPageToken?: string }>(
            Services.build,
            "GetBuildStepLogs",
            compact({ projectId, buildId, buildStepDigest, pageToken }),
          );
          return { entries: (page.logs ?? []).map((log) => ({ body: log.message ?? "" })), nextPageToken: page.nextPageToken };
        }, filter);
        return text(result.text);
      }),
  );
}
