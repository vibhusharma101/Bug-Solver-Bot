import { config } from "./config.js";
import { logger } from "./logger.js";
import { startScheduler, runDailyBugFix } from "./scheduler.js";

async function main() {
  logger.info("╔════════════════════════════════════════╗");
  logger.info("║      🤖  BUG SOLVER BOT  v1.0.0        ║");
  logger.info("╚════════════════════════════════════════╝");

  if (config.bot.dryRun) {
    logger.warn("⚠️  DRY RUN MODE: No real API calls will be made");
  }

  logger.info("Configuration:");
  logger.info(`  GitHub Repo  : ${config.github.owner}/${config.github.repo}`);
  logger.info(`  Sentry Org   : ${config.sentry.org}`);
  logger.info(`  Sentry Project: ${config.sentry.project}`);
  logger.info(`  Max Bugs/Run : ${config.bot.maxBugsPerRun}`);
  logger.info(`  Cron Schedule: ${config.bot.cronSchedule}`);
  logger.info(`  Slack Notify : ${config.slack.webhookUrl ? "✅ Enabled" : "❌ Disabled"}`);

  // --trigger-now flag fires the job immediately (useful for testing)
  const triggerNow = process.argv.includes("--trigger-now");

  if (triggerNow) {
    logger.info("\n🚀 --trigger-now flag detected. Running immediately...\n");
    await runDailyBugFix();
  } else {
    // Start the cron scheduler (runs daily at configured time)
    startScheduler();
    logger.info("\n✅ Bot is running. Waiting for next scheduled run...");
    logger.info("   Ctrl+C to stop.\n");
  }
}

main().catch((err: unknown) => {
  console.error(
    "Fatal startup error:",
    err instanceof Error ? err.message : err
  );
  process.exit(1);
});
