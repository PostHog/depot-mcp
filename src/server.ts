import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { DepotClient } from "./depot.js";
import { registerTools } from "./tools.js";

export const SERVER_NAME = "depot-mcp";
export const SERVER_VERSION = "0.1.0";

export interface HttpServerOptions {
  depotApiUrl?: string;
  fetch?: typeof fetch;
}

export function buildMcpServer(client: DepotClient): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read-only access to the Depot API (Depot CI, GitHub Actions on Depot runners, container builds). " +
        "To find why CI failed: ci_list_runs with status=[\"failed\"] -> ci_diagnose_failure -> ci_get_job_logs. " +
        "For GitHub Actions on Depot runners: gha_list_jobs with conclusions=[\"failure\"] -> gha_search_logs / gha_get_test_results.",
    },
  );
  registerTools(server, client);
  return server;
}

export function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function jsonRpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, options: HttpServerOptions): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    jsonRpcError(res, 405, "Method not allowed. This server is stateless; use POST.");
    return;
  }

  const token = bearerToken(req.headers.authorization);
  if (!token) {
    jsonRpcError(res, 401, "Missing Depot API token. Send it as 'Authorization: Bearer <token>'.");
    return;
  }
  const orgHeader = req.headers["x-depot-org"];
  const org = Array.isArray(orgHeader) ? orgHeader[0] : orgHeader;

  // Stateless: a fresh server and transport per request, scoped to the caller's token.
  const client = new DepotClient({ token, org, baseUrl: options.depotApiUrl, fetch: options.fetch });
  const server = buildMcpServer(client);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

export function createHttpServer(options: HttpServerOptions = {}): Server {
  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (path === "/healthz") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (path !== "/mcp") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    handleMcp(req, res, options).catch((error) => {
      console.error("Error handling MCP request", error);
      if (!res.headersSent) {
        jsonRpcError(res, 500, "Internal server error");
      }
    });
  });
}
