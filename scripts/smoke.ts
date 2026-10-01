// Calls the running server's tools with a real Depot token from .env (DEPOT_TOKEN=...).
// Usage: pnpm smoke [repo]   e.g. pnpm smoke PostHog/posthog
import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function loadToken(): string {
  if (process.env.DEPOT_TOKEN) return process.env.DEPOT_TOKEN;
  const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
  const token = env.match(/^DEPOT_TOKEN=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!token) throw new Error("Set DEPOT_TOKEN in .env");
  return token;
}

const url = process.env.MCP_URL ?? "http://localhost:3000/mcp";
const repo = process.argv[2];
const headers: Record<string, string> = { Authorization: `Bearer ${loadToken()}` };
if (process.env.DEPOT_ORG) headers["X-Depot-Org"] = process.env.DEPOT_ORG;

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));

async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? "";
  console.log(`\n=== ${name} ${JSON.stringify(args)} ${result.isError ? "(ERROR)" : ""}`);
  console.log(text.length > 1500 ? `${text.slice(0, 1500)}\n... (${text.length} chars total)` : text);
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

await call("list_projects", { pageSize: 5 });

const runs = (await call("ci_list_runs", { status: ["failed"], pageSize: 3, ...(repo ? { repo } : {}) })) as
  | { runs?: { runId?: string; id?: string }[] }
  | undefined;
const runId = runs?.runs?.[0]?.runId ?? runs?.runs?.[0]?.id;
if (runId) {
  await call("ci_diagnose_failure", { targetType: "run", targetId: runId });
}

const jobs = (await call("gha_list_jobs", {
  conclusions: ["failure"],
  pageSize: 3,
  ...(repo ? { repositories: [repo] } : {}),
})) as { jobs?: { jobId?: string; repository?: string }[] } | undefined;
const job = jobs?.jobs?.[0];
if (job?.jobId && job.repository) {
  await call("gha_get_test_results", { repository: job.repository, jobId: job.jobId });
}

await call("gha_search_logs", { query: "error", pageSize: 3, ...(repo ? { repositories: [repo] } : {}) });

await client.close();
