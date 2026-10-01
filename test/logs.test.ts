import { describe, expect, it, vi } from "vitest";

import { collectLogs, type LogEntry, type LogFilter, type LogPage } from "../src/logs.js";

const ENTRIES: LogEntry[] = [
  { body: "checkout ok", step: "Checkout" },
  { body: "installing deps", step: "Install" },
  { body: "warning: peer dep", step: "Install", stderr: true },
  { body: "running tests", step: "Test" },
  { body: "FAIL test_foo", step: "Test", stderr: true },
  { body: "AssertionError: expected 1", step: "Test", stderr: true },
  { body: "done", step: undefined },
];

function pager(entries: LogEntry[], pageSize: number) {
  const fetchPage = vi.fn(async (token: string | undefined): Promise<LogPage> => {
    const start = token ? Number(token) : 0;
    const end = start + pageSize;
    return { entries: entries.slice(start, end), nextPageToken: end < entries.length ? String(end) : "" };
  });
  return fetchPage;
}

function bodies(text: string): string[] {
  return text.split("\n").slice(2);
}

describe("collectLogs", () => {
  it.each<{ name: string; filter: LogFilter; expected: string[] }>([
    {
      name: "no filter",
      filter: {},
      expected: [
        "[Checkout] checkout ok",
        "[Install] installing deps",
        "[Install][stderr] warning: peer dep",
        "[Test] running tests",
        "[Test][stderr] FAIL test_foo",
        "[Test][stderr] AssertionError: expected 1",
        "done",
      ],
    },
    { name: "tail", filter: { tail: 2 }, expected: ["[Test][stderr] AssertionError: expected 1", "done"] },
    {
      name: "stderr only",
      filter: { stderrOnly: true },
      expected: ["[Install][stderr] warning: peer dep", "[Test][stderr] FAIL test_foo", "[Test][stderr] AssertionError: expected 1"],
    },
    {
      name: "step name (case-insensitive substring)",
      filter: { stepName: "tes" },
      expected: ["[Test] running tests", "[Test][stderr] FAIL test_foo", "[Test][stderr] AssertionError: expected 1"],
    },
    { name: "contains (case-insensitive)", filter: { contains: "fail" }, expected: ["[Test][stderr] FAIL test_foo"] },
    {
      name: "combined filters with tail",
      filter: { stepName: "test", stderrOnly: true, tail: 1 },
      expected: ["[Test][stderr] AssertionError: expected 1"],
    },
  ])("filters: $name", async ({ filter, expected }) => {
    const result = await collectLogs(pager(ENTRIES, 100), filter);
    expect(bodies(result.text)).toEqual(expected);
    expect(result.returnedLines).toBe(expected.length);
    expect(result.scannedLines).toBe(ENTRIES.length);
  });

  it.each([1, 2, 3, 7, 50])("reads every page (page size %i)", async (pageSize) => {
    const fetchPage = pager(ENTRIES, pageSize);
    const result = await collectLogs(fetchPage, { tail: 1 });

    expect(fetchPage).toHaveBeenCalledTimes(Math.ceil(ENTRIES.length / pageSize));
    expect(fetchPage.mock.calls[0][0]).toBeUndefined();
    expect(result.scannedLines).toBe(ENTRIES.length);
    expect(bodies(result.text)).toEqual(["done"]);
  });

  it("stops at the scan limit and says so", async () => {
    const fetchPage = pager(ENTRIES, 2);
    const result = await collectLogs(fetchPage, { maxScannedLines: 3 });

    expect(result.scanLimitReached).toBe(true);
    expect(result.scannedLines).toBe(3);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.text).toContain("scan limit of 3 lines reached");
  });

  it("reports matched vs returned counts", async () => {
    const result = await collectLogs(pager(ENTRIES, 100), { stderrOnly: true, tail: 1 });
    expect(result.matchedLines).toBe(3);
    expect(result.returnedLines).toBe(1);
    expect(result.text.split("\n")[0]).toBe("scanned 7 lines, 3 matched filters, showing last 1");
  });

  it.each([
    { name: "empty log", entries: [] as LogEntry[], filter: {} },
    { name: "nothing matches", entries: ENTRIES, filter: { contains: "no-such-text" } },
  ])("returns only the header for $name", async ({ entries, filter }) => {
    const result = await collectLogs(pager(entries, 10), filter);
    expect(result.returnedLines).toBe(0);
    expect(result.text).not.toContain("\n");
  });

  it("treats a missing next page token as the last page", async () => {
    const fetchPage = vi.fn(async (): Promise<LogPage> => ({ entries: [{ body: "only" }] }));
    const result = await collectLogs(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(bodies(result.text)).toEqual(["only"]);
  });
});
