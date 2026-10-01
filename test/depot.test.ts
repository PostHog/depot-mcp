import { describe, expect, it, vi } from "vitest";

import { DepotApiError, DepotClient } from "../src/depot.js";

function mockFetch(status: number, body: string) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(body, { status }));
}

describe("DepotClient.call", () => {
  it.each([
    { org: undefined, expectOrg: undefined },
    { org: "org-123", expectOrg: "org-123" },
  ])("sends a Connect JSON request (org=$org)", async ({ org, expectOrg }) => {
    const fetch = mockFetch(200, JSON.stringify({ runs: [] }));
    const client = new DepotClient({ token: "tok", org, baseUrl: "https://api.example.com/", fetch });

    const result = await client.call("depot.ci.v1.CIService", "ListRuns", { repo: "a/b" });

    expect(result).toEqual({ runs: [] });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/depot.ci.v1.CIService/ListRuns");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ repo: "a/b" }));
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Connect-Protocol-Version"]).toBe("1");
    expect(headers["x-depot-org"]).toBe(expectOrg);
  });

  it.each([
    { name: "empty body", body: "", expected: {} },
    { name: "json body", body: '{"a":1}', expected: { a: 1 } },
  ])("parses a 200 response with $name", async ({ body, expected }) => {
    const client = new DepotClient({ token: "t", fetch: mockFetch(200, body) });
    await expect(client.call("s", "m")).resolves.toEqual(expected);
  });

  it("defaults the body to an empty object", async () => {
    const fetch = mockFetch(200, "{}");
    await new DepotClient({ token: "t", fetch }).call("s", "m");
    expect(fetch.mock.calls[0][1]?.body).toBe("{}");
  });

  it.each([
    {
      name: "connect error",
      status: 401,
      body: JSON.stringify({ code: "unauthenticated", message: "bad token" }),
      code: "unauthenticated",
      message: "bad token",
    },
    {
      name: "not found",
      status: 404,
      body: JSON.stringify({ code: "not_found", message: "run not found" }),
      code: "not_found",
      message: "run not found",
    },
    { name: "non-JSON body", status: 502, body: "<html>Bad gateway</html>", code: "unknown", message: "<html>Bad gateway</html>" },
    { name: "JSON without code", status: 500, body: JSON.stringify({ message: "boom" }), code: "unknown", message: "boom" },
  ])("maps $name to DepotApiError", async ({ status, body, code, message }) => {
    const client = new DepotClient({ token: "t", fetch: mockFetch(status, body) });
    const error = await client.call("svc", "Method").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DepotApiError);
    const apiError = error as DepotApiError;
    expect(apiError.status).toBe(status);
    expect(apiError.code).toBe(code);
    expect(apiError.message).toContain(message);
    expect(apiError.message).toContain("svc/Method");
  });

  it("passes an abort signal to fetch", async () => {
    const fetch = mockFetch(200, "{}");
    await new DepotClient({ token: "t", fetch }).call("s", "m");
    expect(fetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps a timeout to a deadline_exceeded DepotApiError", async () => {
    const hangingFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const client = new DepotClient({ token: "t", timeoutMs: 20, fetch: hangingFetch });
    const error = await client.call("svc", "Slow").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DepotApiError);
    expect((error as DepotApiError).code).toBe("deadline_exceeded");
    expect((error as DepotApiError).status).toBe(504);
    expect((error as DepotApiError).message).toContain("svc/Slow timed out after 0.02s");
  });

  it("re-throws network errors that are not timeouts", async () => {
    const failingFetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = new DepotClient({ token: "t", fetch: failingFetch });
    await expect(client.call("s", "m")).rejects.toThrow("fetch failed");
  });

  it("uses DEPOT_API_URL when no baseUrl is given", async () => {
    vi.stubEnv("DEPOT_API_URL", "https://env.example.com");
    const fetch = mockFetch(200, "{}");
    await new DepotClient({ token: "t", fetch }).call("s", "m");
    expect(fetch.mock.calls[0][0]).toBe("https://env.example.com/s/m");
    vi.unstubAllEnvs();
  });
});
