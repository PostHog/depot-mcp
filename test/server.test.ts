import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { bearerToken, createHttpServer } from "../src/server.js";

const depotFetch = vi.fn<typeof fetch>();
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createHttpServer({ depotApiUrl: "https://depot.test", fetch: depotFetch });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  depotFetch.mockReset();
  depotFetch.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
});

async function connect(headers: Record<string, string> = { Authorization: "Bearer test-token" }) {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers } }));
  return client;
}

function lastDepotRequest() {
  const [url, init] = depotFetch.mock.calls.at(-1)!;
  return { url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
}

const EXPECTED_TOOLS = [
  "ci_diagnose_failure",
  "ci_get_job_logs",
  "ci_get_job_summary",
  "ci_get_run",
  "ci_get_workflow",
  "ci_list_artifacts",
  "ci_list_runs",
  "ci_list_workflows",
  "get_build",
  "get_build_step_logs",
  "get_build_steps",
  "gha_get_job",
  "gha_get_log_context",
  "gha_get_test_results",
  "gha_list_job_runs",
  "gha_list_jobs",
  "gha_search_logs",
  "list_builds",
  "list_projects",
];

describe("HTTP routing", () => {
  it.each([
    { name: "no header", headers: {} as Record<string, string> },
    { name: "wrong scheme", headers: { Authorization: "Basic abc" } },
    { name: "empty bearer", headers: { Authorization: "Bearer " } },
  ])("POST /mcp with $name returns 401", async ({ headers }) => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toContain("Missing Depot API token");
  });

  it.each(["GET", "DELETE"])("%s /mcp returns 405", async (method) => {
    const res = await fetch(`${baseUrl}/mcp`, { method, headers: { Authorization: "Bearer t" } });
    expect(res.status).toBe(405);
  });

  it("GET /healthz returns 200", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("unknown path returns 404", async () => {
    expect((await fetch(`${baseUrl}/nope`)).status).toBe(404);
  });
});

describe("bearerToken", () => {
  it.each([
    { header: undefined, expected: undefined },
    { header: "", expected: undefined },
    { header: "Bearer abc", expected: "abc" },
    { header: "bearer abc", expected: "abc" },
    { header: "Bearer   abc  ", expected: "abc" },
    { header: "Token abc", expected: undefined },
  ])("parses $header", ({ header, expected }) => {
    expect(bearerToken(header)).toBe(expected);
  });
});

describe("MCP tools", () => {
  it("lists every tool as read-only", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    await client.close();
  });

  it.each([
    {
      tool: "ci_list_runs",
      args: { repo: "PostHog/posthog", status: ["failed"], pr: "123" },
      path: "depot.ci.v1.CIService/ListRuns",
      body: { repo: "PostHog/posthog", status: ["failed"], pr: "123" },
    },
    { tool: "ci_get_run", args: { runId: "r1" }, path: "depot.ci.v1.CIService/GetRun", body: { runId: "r1" } },
    {
      tool: "ci_diagnose_failure",
      args: { targetType: "job", targetId: "j1" },
      path: "depot.ci.v1.CIService/GetFailureDiagnosis",
      body: { targetId: "j1", targetType: "FAILURE_DIAGNOSIS_TARGET_TYPE_JOB" },
    },
    {
      tool: "ci_get_job_summary",
      args: { attemptId: "a1" },
      path: "depot.ci.v1.CIService/GetJobSummary",
      body: { attemptId: "a1" },
    },
    {
      tool: "ci_list_artifacts",
      args: { runId: "r1", jobId: "j1" },
      path: "depot.ci.v1.CIService/ListArtifacts",
      body: { runId: "r1", jobId: "j1" },
    },
    {
      tool: "gha_list_jobs",
      args: { repositories: ["PostHog/posthog"], conclusions: ["failure"], statuses: ["finished"], startAt: "2026-01-01T00:00:00Z" },
      path: "depot.core.v1.GithubActionsService/ListGithubActionsJobs",
      body: {
        repositories: ["PostHog/posthog"],
        conclusions: ["GITHUB_ACTIONS_JOB_CONCLUSION_FAILURE"],
        statuses: ["GITHUB_ACTIONS_JOB_STATUS_FINISHED"],
        timeRange: { startAt: "2026-01-01T00:00:00Z" },
      },
    },
    {
      tool: "gha_search_logs",
      args: { query: "error", repositories: ["a/b"], pageSize: 10 },
      path: "depot.core.v1.GithubActionsService/SearchGithubActionsLogs",
      body: { query: "error", filters: { repositories: ["a/b"] }, pageSize: 10 },
    },
    {
      tool: "gha_search_logs",
      args: { query: "error" },
      path: "depot.core.v1.GithubActionsService/SearchGithubActionsLogs",
      body: { query: "error" },
    },
    {
      tool: "gha_get_log_context",
      args: { lineId: "l1", repository: "a/b", surroundingLineCount: 20 },
      path: "depot.core.v1.GithubActionsService/GetGithubActionsLogContext",
      body: { lineId: "l1", repository: "a/b", surroundingLineCount: 20 },
    },
    {
      tool: "gha_list_job_runs",
      args: { repository: "a/b", jobName: "test", endAt: "2026-02-01T00:00:00Z" },
      path: "depot.core.v1.GithubActionsService/ListGithubActionsJobRuns",
      body: { repository: "a/b", jobName: "test", timeRange: { endAt: "2026-02-01T00:00:00Z" } },
    },
    {
      tool: "gha_get_test_results",
      args: { repository: "a/b", jobId: "9" },
      path: "depot.core.v1.GithubActionsService/GetGithubActionsTestResultsSummary",
      body: { repository: "a/b", jobId: "9" },
    },
    { tool: "list_projects", args: {}, path: "depot.core.v1.ProjectService/ListProjects", body: {} },
    {
      tool: "list_builds",
      args: { projectId: "p1", pageSize: 5 },
      path: "depot.core.v1.BuildService/ListBuilds",
      body: { projectId: "p1", pageSize: 5 },
    },
    { tool: "get_build", args: { buildId: "b1" }, path: "depot.core.v1.BuildService/GetBuild", body: { buildId: "b1" } },
    {
      tool: "get_build_steps",
      args: { projectId: "p1", buildId: "b1" },
      path: "depot.build.v1.BuildService/GetBuildSteps",
      body: { projectId: "p1", buildId: "b1" },
    },
  ])("$tool calls $path", async ({ tool, args, path, body }) => {
    const client = await connect({ Authorization: "Bearer test-token", "X-Depot-Org": "org-1" });
    const result = await client.callTool({ name: tool, arguments: args });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ ok: true }) }]);
    const request = lastDepotRequest();
    expect(request.url).toBe(`https://depot.test/${path}`);
    expect(request.body).toEqual(body);
    expect(request.headers.Authorization).toBe("Bearer test-token");
    expect(request.headers["x-depot-org"]).toBe("org-1");
    await client.close();
  });

  it("ci_get_job_logs pages through logs and filters them", async () => {
    const pages: Record<string, unknown> = {
      "": {
        lines: [
          { body: "setup", stepName: "Setup", stream: 0 },
          { body: "Error: boom", stepName: "Test", stream: 1 },
        ],
        nextPageToken: "p2",
      },
      p2: { lines: [{ body: "more errors", stepName: "Test", stream: 1 }, { body: "cleanup", stepKey: "post", stream: 0 }] },
    };
    depotFetch.mockImplementation(async (_url, init) => {
      const { pageToken = "" } = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(pages[pageToken]), { status: 200 });
    });

    const client = await connect();
    const result = await client.callTool({ name: "ci_get_job_logs", arguments: { attemptId: "a1", stderrOnly: true } });

    const output = (result.content as { text: string }[])[0].text;
    expect(output).toContain("scanned 4 lines, 2 matched filters, showing last 2");
    expect(output).toContain("[Test][stderr] Error: boom\n[Test][stderr] more errors");
    expect(output).not.toContain("setup");
    expect(depotFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(depotFetch.mock.calls[0][1]?.body))).toEqual({ attemptId: "a1" });
    expect(JSON.parse(String(depotFetch.mock.calls[1][1]?.body))).toEqual({ attemptId: "a1", pageToken: "p2" });
    await client.close();
  });

  it("get_build_step_logs returns the tail of the step log", async () => {
    depotFetch.mockImplementation(
      async () => new Response(JSON.stringify({ logs: [{ message: "a" }, { message: "b" }, { message: "c" }] }), { status: 200 }),
    );
    const client = await connect();
    const result = await client.callTool({
      name: "get_build_step_logs",
      arguments: { projectId: "p", buildId: "b", buildStepDigest: "sha256:x", tail: 2 },
    });

    expect((result.content as { text: string }[])[0].text).toBe("scanned 3 lines, 3 matched filters, showing last 2\n\nb\nc");
    expect(lastDepotRequest().body).toEqual({ projectId: "p", buildId: "b", buildStepDigest: "sha256:x" });
    await client.close();
  });

  it("returns Depot API errors as tool errors", async () => {
    depotFetch.mockImplementation(
      async () => new Response(JSON.stringify({ code: "permission_denied", message: "token lacks access" }), { status: 403 }),
    );
    const client = await connect();
    const result = await client.callTool({ name: "ci_get_run", arguments: { runId: "r1" } });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("token lacks access");
    await client.close();
  });

  it("ci_get_job_summary requires jobId or attemptId", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "ci_get_job_summary", arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("Set jobId or attemptId");
    expect(depotFetch).not.toHaveBeenCalled();
    await client.close();
  });

  it.each([
    { name: "no time range", args: {}, expected: { startAt: "2026-03-09T12:00:00.000Z" } },
    { name: "only endAt", args: { endAt: "2026-03-01T00:00:00Z" }, expected: { endAt: "2026-03-01T00:00:00Z" } },
    {
      name: "explicit startAt",
      args: { startAt: "2026-01-01T00:00:00Z" },
      expected: { startAt: "2026-01-01T00:00:00Z" },
    },
  ])("gha_list_jobs time range with $name", async ({ args, expected }) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-10T12:00:00Z"));
    const client = await connect();
    await client.callTool({ name: "gha_list_jobs", arguments: args });
    vi.mocked(Date.now).mockRestore();

    expect(lastDepotRequest().body.timeRange).toEqual(expected);
    await client.close();
  });

  it("does not send x-depot-org when the header is absent", async () => {
    const client = await connect();
    await client.callTool({ name: "list_projects", arguments: {} });
    expect(lastDepotRequest().headers["x-depot-org"]).toBeUndefined();
    await client.close();
  });
});
