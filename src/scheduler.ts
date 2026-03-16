import cron from "node-cron";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { getTopBugs } from "./sentry.js";
import { solveIssue, AgentResult } from "./agent.js";
import { createSentryMcpBridge, McpBridge } from "./mcp.js";

// ---- Daily Run Logic ------------------------------------------------------

export async function runDailyBugFix(): Promise<void> {
  const runStart = Date.now();
  logger.info("═".repeat(60));
  logger.info("🤖 Bug Solver Bot — Daily Run Started");
  logger.info(`Timestamp: ${new Date().toISOString()}`);
  logger.info("═".repeat(60));

  const results: AgentResult[] = [];

  // Create ONE MCP bridge for the whole run — avoids spinning up/down the
  // Sentry MCP subprocess for each individual issue (expensive)
  let mcp: McpBridge | null = null;

  try {
    // Boot the Sentry MCP server
    mcp = await createSentryMcpBridge();

    // Fetch top N bugs from Sentry (for the schedule/loop — Claude will deep
    // dive each one via MCP tools)
    const issues = await getTopBugs(config.bot.maxBugsPerRun);

    if (issues.length === 0) {
      logger.info("✅ No unresolved Sentry issues found. Nothing to fix!");
      return;
    }

    // Process issues sequentially to avoid API rate limits
    for (let i = 0; i < issues.length; i++) {
      logger.info(`\n[${i + 1}/${issues.length}] Working on issue...`);
      const result = await solveIssue(issues[i], mcp);
      results.push(result);

      // Brief pause between issues to avoid hammering APIs
      if (i < issues.length - 1) {
        await sleep(3000);
      }
    }
  } catch (err: unknown) {
    logger.error("Fatal error during daily run", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Always shut down the MCP subprocess cleanly
    if (mcp) await mcp.close();

    // Print run summary
    const duration = ((Date.now() - runStart) / 1000).toFixed(1);
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    logger.info("\n" + "═".repeat(60));
    logger.info("📊 Daily Run Summary");
    logger.info(`  Total issues processed : ${results.length}`);
    logger.info(`  ✅ Successfully fixed  : ${succeeded}`);
    logger.info(`  ❌ Could not fix       : ${failed}`);
    logger.info(`  ⏱️  Duration            : ${duration}s`);

    results.forEach((r) => {
      if (r.success) {
        logger.info(`  🔗 [${r.shortId}] PR: ${r.prUrl}`);
      } else {
        logger.warn(`  ⚠️  [${r.shortId}] Skipped: ${r.reason}`);
      }
    });

    logger.info("═".repeat(60));
  }
}


// ---- Scheduler ------------------------------------------------------------

export function startScheduler(): void {
  const schedule = config.bot.cronSchedule;

  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron schedule: "${schedule}"`);
  }

  logger.info(`📅 Scheduler started — Cron: "${schedule}"`);
  logger.info(`   Next run: ${getNextRunTime(schedule)}`);

  cron.schedule(schedule, () => {
    runDailyBugFix().catch((err: unknown) => {
      logger.error("Unhandled error in scheduler callback", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

// ---- Helpers --------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getNextRunTime(schedule: string): string {
  try {
    // Simple human-readable hint: just show the schedule
    return `Based on schedule "${schedule}" (use crontab.guru to decode)`;
  } catch {
    return "Unknown";
  }
}
