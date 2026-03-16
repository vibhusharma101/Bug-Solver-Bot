import { SentryIssue } from "./sentry.js";
import { createBranch, commitFileFix, openPullRequest, getFileContent } from "./github.js";
import { analyzeBugAndFix } from "./claude.js";
import { notifySlack } from "./slack.js";
import { McpBridge } from "./mcp.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

// ---- Types ----------------------------------------------------------------

export interface AgentResult {
  issueId: string;
  shortId: string;
  success: boolean;
  prUrl?: string;
  reason?: string;
}

// ---- Main Orchestrator ----------------------------------------------------

/**
 * Full pipeline for a single Sentry issue (MCP-powered):
 * 1. Claude actively investigates the issue via Sentry MCP tools
 * 2. Claude fetches the relevant source file from GitHub via tool call
 * 3. Claude returns a structured JSON fix
 * 4. We create a branch, commit the fix, and open a GitHub PR
 * 5. Notify Slack
 *
 * The key difference vs the old approach: Claude drives step 1 & 2 itself.
 * We only handle the git operations (steps 4-5).
 */
export async function solveIssue(
  issue: SentryIssue,
  mcp: McpBridge
): Promise<AgentResult> {
  logger.info(`\n${"─".repeat(60)}`);
  logger.info(`Processing: [${issue.shortId}] ${issue.title}`);
  logger.info(`Culprit: ${issue.culprit} | Events: ${issue.count}`);

  // ---- DRY RUN mode --------------------------------------------------------
  if (config.bot.dryRun) {
    logger.info(`[DRY RUN] Skipping real API calls for ${issue.shortId}`);
    return {
      issueId: issue.id,
      shortId: issue.shortId,
      success: true,
      prUrl: "https://github.com/dry-run/pr/0",
    };
  }

  try {
    // Step 1-3: Claude investigates via MCP + fetches files + generates fix
    const fix = await analyzeBugAndFix(issue, mcp);

    if (!fix) {
      const reason = "Claude could not generate a fix for this issue";
      logger.warn(`[${issue.shortId}] ${reason}`);
      await notifySlack({
        issueShortId: issue.shortId,
        issueTitle: issue.title,
        sentryPermalink: issue.permalink,
        prUrl: "",
        prNumber: 0,
        explanation: "",
        filePath: "",
        success: false,
        errorReason: reason,
      });
      return { issueId: issue.id, shortId: issue.shortId, success: false, reason };
    }

    // Step 4: Create branch first
    const branchName = `fix/sentry-${issue.shortId.toLowerCase()}`;
    await createBranch(branchName);

    // Step 5: Get the current content from THE BASE BRANCH (to ensure we have the broken code)
    const baseFile = await getFileContent(fix.filePath, config.github.baseBranch);
    if (!baseFile) {
      throw new Error(`File not found in repo: ${fix.filePath}`);
    }

    // Also get the SHA from the branch we're committing to (to avoid conflicts)
    const branchFile = await getFileContent(fix.filePath, branchName);
    const targetSha = branchFile?.sha || baseFile.sha;

    // Step 6: Apply the surgical fix with Smart Match (resilient to indent/spacing)
    let patchedCode = baseFile.content.replace(fix.search, fix.replace);
    
    if (patchedCode === baseFile.content) {
      logger.info(`[${issue.shortId}] Exact match failed, trying Smart Line Match...`);
      logger.info(`[${issue.shortId}] Looking for search block:\n${fix.search}`);
      
      const fileLines = baseFile.content.split(/\r?\n/);
      const searchLines = fix.search.split(/\r?\n/).map(l => l.trim());
      
      let foundIndex = -1;
      let bestMatch = { index: -1, score: 0 };

      for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
        let matchCount = 0;
        for (let j = 0; j < searchLines.length; j++) {
            // "Normal Match": Ignore all non-alphanumeric characters for extreme resilience
            const lineA = fileLines[i + j].replace(/[^a-zA-Z0-9]/g, '');
            const lineB = searchLines[j].replace(/[^a-zA-Z0-9]/g, '');
            
            if (lineA === lineB && lineB.length > 0) {
                matchCount++;
            } else if (lineA !== lineB) {
                break;
            }
        }
        
        if (matchCount === searchLines.length) {
            foundIndex = i;
            break;
        }
        
        if (matchCount > bestMatch.score) {
            bestMatch = { index: i, score: matchCount };
        }
      }

      if (foundIndex !== -1) {
          fileLines.splice(foundIndex, searchLines.length, fix.replace);
          patchedCode = fileLines.join('\n');
          logger.info(`[${issue.shortId}] Normal Match found at line ${foundIndex + 1}!`);
      } else {
          // Tier 3: Best Effort Match (Single Line)
          // If the block didn't match perfectly, try matching just the first line that has alphanumeric content.
          logger.info(`[${issue.shortId}] Block match failed. Trying single-line Best Effort match...`);
          
          const primarySearchLine = searchLines.find(l => l.replace(/[^a-zA-Z0-9]/g, '').length > 10) || searchLines[0];
          const normPrimary = primarySearchLine.replace(/[^a-zA-Z0-9]/g, '');
          logger.info(`[${issue.shortId}] Best Effort Target: ${normPrimary}`);
          
          const singleLineIndex = fileLines.findIndex((fLine, fIdx) => {
            const normFLine = fLine.replace(/[^a-zA-Z0-9]/g, '');
            if (fIdx > 90 && fIdx < 110) {
                logger.info(`[${issue.shortId}] Line ${fIdx + 1} norm: ${normFLine}`);
            }
            return normFLine.includes(normPrimary) && normPrimary.length > 5;
          });

          if (singleLineIndex !== -1) {
              logger.info(`[${issue.shortId}] Best Effort: Found primary line at line ${singleLineIndex + 1}!`);
              // We replace the single line. This is safer than failing entirely.
              fileLines[singleLineIndex] = fix.replace;
              patchedCode = fileLines.join('\n');
          } else {
              if (bestMatch.index !== -1) {
                  const idx = bestMatch.index + bestMatch.score;
                  logger.warn(`[${issue.shortId}] Match failed at line ${idx + 1}.`);
                  logger.warn(`  Expected (norm): ${searchLines[bestMatch.score].replace(/[^a-zA-Z0-9]/g, '')}`);
                  logger.warn(`  Found    (norm): ${fileLines[idx].replace(/[^a-zA-Z0-9]/g, '')}`);
              }
              throw new Error(`Surgical fix failed: Could not find code block in ${fix.filePath}.`);
          }
      }
    }

    await commitFileFix(
      branchName,
      fix.filePath,
      patchedCode,
      fix.commitMessage,
      targetSha
    );

    // Step 6: Open PR
    const prBody = buildPrBody(issue, fix);
    const pr = await openPullRequest(branchName, `fix: ${issue.title}`, prBody);

    // Step 7: Notify Slack
    await notifySlack({
      issueShortId: issue.shortId,
      issueTitle: issue.title,
      sentryPermalink: issue.permalink,
      prUrl: pr.url,
      prNumber: pr.number,
      explanation: fix.explanation,
      filePath: fix.filePath,
      success: true,
    });

    logger.info(`[${issue.shortId}] ✅ PR opened: ${pr.url}`);
    return { issueId: issue.id, shortId: issue.shortId, success: true, prUrl: pr.url };

  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(`[${issue.shortId}] ❌ Unexpected error`, { error: reason });
    return { issueId: issue.id, shortId: issue.shortId, success: false, reason };
  }
}

// ---- Helpers --------------------------------------------------------------

function buildPrBody(
  issue: SentryIssue,
  fix: { explanation: string; filePath: string }
): string {
  return [
    `## 🤖 Automated Fix by Bug Solver Bot`,
    ``,
    `This PR was automatically generated by an AI agent that deeply investigated a Sentry error using the Sentry MCP server.`,
    ``,
    `### Sentry Issue`,
    `- **ID:** [${issue.shortId}](${issue.permalink})`,
    `- **Error:** \`${issue.errorType}: ${issue.errorValue}\``,
    `- **Culprit:** \`${issue.culprit}\``,
    `- **Frequency:** ${issue.count} events`,
    ``,
    `### How This Fix Was Generated`,
    `1. Claude queried Sentry via MCP to get full event details and stack trace`,
    `2. Claude fetched the source file from GitHub`,
    `3. Claude identified the root cause and generated a minimal fix`,
    ``,
    `### Fix Summary`,
    `**File modified:** \`${fix.filePath}\``,
    ``,
    fix.explanation,
    ``,
    `---`,
    `> ⚠️ **Human review required.** Please verify this fix before merging.`,
    `> This PR was auto-generated by Bug Solver Bot powered by Claude + Sentry MCP.`,
  ].join("\n");
}
