export const DEFAULT_DEPOT_API_URL = "https://api.depot.dev";
export const DEFAULT_TIMEOUT_MS = 60_000;

export class DepotApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DepotApiError";
  }
}

export interface DepotClientOptions {
  token: string;
  org?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

// Thin client for Depot's Connect RPC API, using the Connect JSON protocol.
export class DepotClient {
  private readonly token: string;
  private readonly org?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DepotClientOptions) {
    this.token = options.token;
    this.org = options.org;
    this.baseUrl = (options.baseUrl ?? process.env.DEPOT_API_URL ?? DEFAULT_DEPOT_API_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? (Number(process.env.DEPOT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async call<T = unknown>(service: string, method: string, body: object = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    };
    if (this.org) {
      headers["x-depot-org"] = this.org;
    }

    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${service}/${method}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new DepotApiError(
          504,
          "deadline_exceeded",
          `Depot API ${service}/${method} timed out after ${this.timeoutMs / 1000}s. Narrow the request, for example with a shorter time range or a repository filter.`,
        );
      }
      throw error;
    }

    if (!response.ok) {
      let code = "unknown";
      let message = text || response.statusText;
      try {
        const parsed = JSON.parse(text) as { code?: string; message?: string };
        code = parsed.code ?? code;
        message = parsed.message ?? message;
      } catch {
        // Non-JSON error body (e.g. from a proxy); keep the raw text.
      }
      throw new DepotApiError(response.status, code, `Depot API ${service}/${method} failed (${response.status} ${code}): ${message}`);
    }

    return (text ? JSON.parse(text) : {}) as T;
  }
}

export const Services = {
  ci: "depot.ci.v1.CIService",
  githubActions: "depot.core.v1.GithubActionsService",
  project: "depot.core.v1.ProjectService",
  coreBuild: "depot.core.v1.BuildService",
  build: "depot.build.v1.BuildService",
} as const;
