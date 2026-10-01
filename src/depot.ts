export const DEFAULT_DEPOT_API_URL = "https://api.depot.dev";

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
  fetch?: typeof fetch;
}

// Thin client for Depot's Connect RPC API, using the Connect JSON protocol.
export class DepotClient {
  private readonly token: string;
  private readonly org?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DepotClientOptions) {
    this.token = options.token;
    this.org = options.org;
    this.baseUrl = (options.baseUrl ?? process.env.DEPOT_API_URL ?? DEFAULT_DEPOT_API_URL).replace(/\/+$/, "");
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

    const response = await this.fetchImpl(`${this.baseUrl}/${service}/${method}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const text = await response.text();
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
