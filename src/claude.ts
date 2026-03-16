import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { SentryIssue } from "./sentry.js";
import { getFileContent } from "./github.js";
import { McpBridge } from "./mcp.js";

// ---- Types ----------------------------------------------------------------

export interface ClaudeFix {
  filePath: string;
  fixedCode: string;
  explanation: string;
  commitMessage: string;
}

// ---- Client ---------------------------------------------------------------

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ---- System Prompt --------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert Senior Software Engineer specializing in debugging and fixing production bugs.

You have access to Sentry tools to deeply investigate issues (stack traces, events, breadcrumbs, user context) and a GitHub file fetcher to read source code.

## Your workflow for each bug:
1. Call the appropriate Sentry tool to get full issue details (stack trace, events, affected users)
2. Identify the exact file and line causing the error from the stack trace
3. Call fetch_github_file to read that source file
4. If needed, fetch additional related files for context
5. Identify the ROOT CAUSE — not just the symptom
6. Generate a minimal, targeted fix

## Output format:
When you have fully investigated and are ready to provide the fix, respond with ONLY a JSON object — no markdown, no explanation outside the JSON:

{
  "filePath": "relative/path/to/the/file",
  "fixedCode": "the COMPLETE fixed file content with the fix applied",
  "explanation": "2-3 sentences: what caused the bug, what the fix does, why it's correct",
  "commitMessage": "fix: short description under 72 chars"
}

## Rules:
- Fix ONLY the bug. Preserve all other code exactly (style, formatting, variable names)
- Never rewrite or refactor code that isn't broken
- Fixes must be minimal and surgical
- If you genuinely cannot determine a safe fix, respond with: {"error": "reason why"}`;

// ---- Custom GitHub tool definition ----------------------------------------

const GITHUB_FETCH_TOOL: Anthropic.Tool = {
  name: "fetch_github_file",
  description:
    "Fetch the content of a source file from the GitHub repository. Use this to read the code that is causing the error.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description:
          "Relative file path in the repository (e.g. src/auth/login.ts). Do NOT include a leading slash.",
      },
    },
    required: ["path"],
  },
};

// ---- Main Agentic Loop ----------------------------------------------------

/**
 * Runs an agentic Claude conversation where Claude:
 * - Actively queries Sentry via MCP tools to investigate the issue
 * - Fetches source files from GitHub
 * - Returns a structured fix when ready
 *
 * Claude drives the investigation — it decides what data it needs.
 */
export async function analyzeBugAndFix(
  issue: SentryIssue,
  mcp: McpBridge
): Promise<ClaudeFix | null> {
  const allTools: Anthropic.Tool[] = [...mcp.tools, GITHUB_FETCH_TOOL];

  // Seed Claude with just the basic issue info — let it investigate the rest
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `Investigate and fix this Sentry issue:\n\n` +
        `**Sentry Issue ID:** ${issue.shortId}\n` +
        `**Title:** ${issue.title}\n` +
        `**Culprit:** ${issue.culprit}\n` +
        `**Event Count:** ${issue.count} events\n\n` +
        `Use the Sentry tools to get the full stack trace and event details, ` +
        `then fetch the relevant source file from GitHub and provide the fix.`,
    },
  ];

  const MAX_ITERATIONS = 12; // Safety cap on the agentic loop

  logger.info(`[${issue.shortId}] Starting agentic Claude investigation...`);

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: allTools,
      messages,
    });

    logger.info(
      `[${issue.shortId}] Claude iteration ${iteration + 1}: stop_reason=${response.stop_reason}`
    );

    // ── Claude is done: extract the JSON fix ──────────────────────────────
    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        logger.warn(`[${issue.shortId}] Claude returned no text in final response`);
        return null;
      }
      return parseClaudeResponse(textBlock.text, issue);
    }

    // ── Claude wants to call tools ─────────────────────────────────────────
    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      // Add Claude's message (with tool calls) to the conversation
      messages.push({ role: "assistant", content: response.content });

      // Execute each tool call and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        const toolInput = block.input as Record<string, unknown>;
        let result: string;

        if (block.name === "fetch_github_file") {
          result = await handleGitHubFetch(toolInput, issue.shortId);
        } else {
          // Sentry MCP tool
          result = await mcp.callTool(block.name, toolInput);
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      }

      // Feed tool results back into the conversation
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Unexpected stop reason (e.g. max_tokens)
    logger.warn(
      `[${issue.shortId}] Unexpected stop_reason: ${response.stop_reason}`
    );
    break;
  }

  logger.warn(`[${issue.shortId}] Reached max iterations (${MAX_ITERATIONS}) without a fix`);
  return null;
}

// ---- Tool Handlers --------------------------------------------------------

async function handleGitHubFetch(
  input: Record<string, unknown>,
  shortId: string
): Promise<string> {
  const path = typeof input.path === "string" ? input.path : "";
  if (!path) return "Error: path parameter is required";

  logger.info(`  📁 GitHub fetch: ${path}`);
  const fileResult = await getFileContent(path);

  if (!fileResult) {
    return `File not found in repository: ${path}\nTip: Check the exact path from the Sentry stack trace.`;
  }

  logger.info(`  ✅ [${shortId}] Fetched ${path} (${fileResult.content.length} chars)`);
  return fileResult.content;
}

// ---- Response Parsing -----------------------------------------------------

function parseClaudeResponse(
  rawText: string,
  issue: SentryIssue
): ClaudeFix | null {
  // Strip accidental markdown code fences
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    // Claude signalled it can't fix this
    if (parsed.error) {
      logger.warn(
        `[${issue.shortId}] Claude declined to fix: ${parsed.error}`
      );
      return null;
    }

    if (!parsed.filePath || !parsed.fixedCode || !parsed.explanation) {
      logger.warn(
        `[${issue.shortId}] Claude response missing required fields`,
        { keys: Object.keys(parsed) }
      );
      return null;
    }

    return {
      filePath: parsed.filePath as string,
      fixedCode: parsed.fixedCode as string,
      explanation: parsed.explanation as string,
      commitMessage:
        typeof parsed.commitMessage === "string"
          ? parsed.commitMessage
          : `fix: resolve Sentry issue ${issue.shortId}`,
    };
  } catch {
    logger.warn(`[${issue.shortId}] Failed to parse Claude JSON response`, {
      preview: rawText.slice(0, 300),
    });
    return null;
  }
}
