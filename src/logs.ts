export interface LogEntry {
  body: string;
  step?: string;
  stderr?: boolean;
}

export interface LogPage {
  entries: LogEntry[];
  nextPageToken?: string;
}

export interface LogFilter {
  tail?: number;
  stepName?: string;
  stderrOnly?: boolean;
  contains?: string;
  maxScannedLines?: number;
}

export interface LogResult {
  text: string;
  scannedLines: number;
  matchedLines: number;
  returnedLines: number;
  scanLimitReached: boolean;
}

export const DEFAULT_TAIL = 300;
export const DEFAULT_MAX_SCANNED_LINES = 100_000;

export async function collectLogs(
  fetchPage: (pageToken: string | undefined) => Promise<LogPage>,
  filter: LogFilter = {},
): Promise<LogResult> {
  const tail = filter.tail ?? DEFAULT_TAIL;
  const maxScanned = filter.maxScannedLines ?? DEFAULT_MAX_SCANNED_LINES;
  const stepNeedle = filter.stepName?.toLowerCase();
  const textNeedle = filter.contains?.toLowerCase();

  // Only the last `tail` matches are kept, so memory stays bounded on huge logs.
  const kept: LogEntry[] = [];
  let scanned = 0;
  let matched = 0;
  let scanLimitReached = false;
  let pageToken: string | undefined;

  do {
    const page = await fetchPage(pageToken);
    for (const entry of page.entries) {
      if (scanned >= maxScanned) {
        scanLimitReached = true;
        break;
      }
      scanned++;
      if (filter.stderrOnly && !entry.stderr) continue;
      if (stepNeedle && !(entry.step ?? "").toLowerCase().includes(stepNeedle)) continue;
      if (textNeedle && !entry.body.toLowerCase().includes(textNeedle)) continue;
      matched++;
      kept.push(entry);
      if (kept.length > tail) kept.shift();
    }
    pageToken = page.nextPageToken || undefined;
  } while (pageToken && !scanLimitReached);

  const lines = kept.map(formatEntry);
  const header = [
    `scanned ${scanned} lines, ${matched} matched filters, showing last ${lines.length}`,
    scanLimitReached ? `scan limit of ${maxScanned} lines reached; later lines were not read` : undefined,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    text: lines.length ? `${header}\n\n${lines.join("\n")}` : header,
    scannedLines: scanned,
    matchedLines: matched,
    returnedLines: lines.length,
    scanLimitReached,
  };
}

function formatEntry(entry: LogEntry): string {
  const prefix = [entry.step ? `[${entry.step}]` : "", entry.stderr ? "[stderr]" : ""].join("");
  return prefix ? `${prefix} ${entry.body}` : entry.body;
}
