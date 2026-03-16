import axios from "axios";
import { config } from "./config.js";
import { logger } from "./logger.js";

// ---- Types ----------------------------------------------------------------

export interface SentryFrame {
  filename: string | null;
  absPath: string | null;
  function: string | null;
  lineNo: number | null;
  colNo: number | null;
  context: [number, string][];
}

export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  permalink: string;
  count: string; // frequency (as string from Sentry API)
  errorType: string;
  errorValue: string;
  frames: SentryFrame[];
  /** The single most relevant frame (topmost app frame in the stack) */
  topFrame: SentryFrame | null;
}

// ---- API helpers ----------------------------------------------------------

const sentryApi = axios.create({
  baseURL: "https://sentry.io/api/0",
  headers: {
    Authorization: `Bearer ${config.sentry.authToken}`,
    "Content-Type": "application/json",
  },
});

/** Fetch the top N unresolved issues sorted by event frequency */
export async function getTopBugs(limit: number): Promise<SentryIssue[]> {
  logger.info(`Fetching top ${limit} Sentry issues...`, {
    org: config.sentry.org,
    project: config.sentry.project,
  });

  const response = await sentryApi.get(
    `/projects/${config.sentry.org}/${config.sentry.project}/issues/`,
    {
      params: {
        query: "is:unresolved",
        sort: "freq",
        limit,
      },
    }
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const issues: SentryIssue[] = response.data.map((raw: any) =>
    parseSentryIssue(raw)
  );

  logger.info(`Fetched ${issues.length} issues from Sentry`);
  issues.forEach((i, idx) => {
    logger.info(`  [${idx + 1}] ${i.shortId} — ${i.title} (${i.count} events)`);
  });

  return issues;
}

// ---- Parsing --------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseSentryIssue(raw: any): SentryIssue {
  const exception =
    raw.metadata?.type !== undefined
      ? raw.metadata
      : raw.entries?.find((e: any) => e.type === "exception")?.data
          ?.values?.[0] ?? {};

  // Pull frames from the latest event's stack trace
  const rawFrames: any[] =
    raw.entries
      ?.find((e: any) => e.type === "exception")
      ?.data?.values?.[0]?.stacktrace?.frames?.reverse() ?? [];

  const frames: SentryFrame[] = rawFrames.map((f: any) => ({
    filename: f.filename ?? null,
    absPath: f.absPath ?? null,
    function: f.function ?? null,
    lineNo: f.lineNo ?? null,
    colNo: f.colNo ?? null,
    context: f.context ?? [],
  }));

  // Best frame: first frame that is NOT from node_modules and has a filename
  const topFrame =
    frames.find(
      (f) =>
        f.filename &&
        !f.filename.includes("node_modules") &&
        !f.filename.startsWith("<")
    ) ?? frames[0] ?? null;

  return {
    id: raw.id as string,
    shortId: raw.shortId as string,
    title: raw.title as string,
    culprit: raw.culprit as string,
    permalink: raw.permalink as string,
    count: raw.count as string,
    errorType: (raw.metadata?.type ?? exception.type ?? "Unknown") as string,
    errorValue: (raw.metadata?.value ?? exception.value ?? "") as string,
    frames,
    topFrame,
  };
}

/** Build a concise Sentry issue summary for the Claude prompt */
export function formatIssueForPrompt(issue: SentryIssue): string {
  const frameLines = issue.frames
    .slice(0, 10) // Keep prompt size manageable
    .map(
      (f) =>
        `  at ${f.function ?? "?"} (${f.filename ?? "?"}:${f.lineNo ?? "?"})`
    )
    .join("\n");

  return [
    `**Sentry Issue:** ${issue.shortId}`,
    `**Error:** ${issue.errorType}: ${issue.errorValue}`,
    `**Culprit:** ${issue.culprit}`,
    `**Frequency:** ${issue.count} events`,
    `**Stack Trace:**`,
    frameLines,
  ].join("\n");
}
