import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { SentryIssue } from "./sentry.js";
import { getFileContent } from "./github.js";
import { McpBridge } from "./mcp.js";

// ---- Types ----------------------------------------------------------------

export interface ClaudeFix {
  filePath: string;
  search: string;
  replace: string;
  explanation: string;
  commitMessage: string;
}

// ---- Client ---------------------------------------------------------------

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ---- System Prompt --------------------------------------------------------

const SYSTEM_PROMPT = `Senior Engineer. Fix bugs surgicaly.

Output ONLY JSON:
{
  "filePath": "string",
  "search": "Concise, UNIQUE block. COPY VERBATIM from source.",
  "replace": "new code",
  "explanation": "summary",
  "commitMessage": "fix: description"
}

Investigation:
1. get_issue_details
2. fetch_github_file
3. RETURN JSON ONLY. NO TEXT.`;

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
        `**Sentry Context:**\n` +
        `- Organization Slug: ${config.sentry.org}\n` +
        `- Project Slug: ${config.sentry.project}\n\n` +
        `**Issue Info:**\n` +
        `- Sentry Issue ID: ${issue.shortId}\n` +
        `- Title: ${issue.title}\n` +
        `- Culprit: ${issue.culprit}\n\n` +
        `**REQUIRED STEPS:**\n` +
        `1. Call get_issue_details to see the stack trace.\n` +
        `2. Call fetch_github_file to read the causal source code.\n` +
        `3. Apply the fix and return the JSON object.`,
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
  // Try to find the JSON block.
  let cleaned = rawText.trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace !== -1) {
    if (lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    } else {
      cleaned = cleaned.substring(firstBrace);
    }
  }

  // Handle truncation: if it doesn't end with }, try to close it
  if (!cleaned.endsWith('}')) {
    cleaned += '"}'; // Rough attempt to close a string and object
  }

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    if (parsed.error) {
      logger.warn(`[${issue.shortId}] Claude declined: ${parsed.error}`);
      return null;
    }

    const { filePath, search, replace, explanation } = parsed as any;
    if (!filePath || !search || replace === undefined || !explanation) {
      logger.warn(`[${issue.shortId}] Claude response missing fields`, { keys: Object.keys(parsed) });
      return null;
    }

    return {
      filePath: filePath as string,
      search: search as string,
      replace: replace as string,
      explanation: explanation as string,
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
