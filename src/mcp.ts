import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { logger } from "./logger.js";

// ---- Types ----------------------------------------------------------------

export interface McpBridge {
  /** All Sentry MCP tools converted to Anthropic tool format, ready to pass to Claude */
  tools: Anthropic.Tool[];
  /** Call any Sentry MCP tool by name and return its text output */
  callTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  /** Cleanly shut down the MCP subprocess */
  close: () => Promise<void>;
}

// ---- Factory --------------------------------------------------------------

/**
 * Spawns the Sentry MCP server as a subprocess and connects to it via stdio.
 * The MCP server exposes Sentry as Claude-callable tools (list_issues, get_issue, etc.)
 *
 * Usage:
 *   const mcp = await createSentryMcpBridge();
 *   // ... pass mcp.tools to Claude, use mcp.callTool(...) to execute them
 *   await mcp.close();
 */
export async function createSentryMcpBridge(): Promise<McpBridge> {
  logger.info("Starting Sentry MCP server...");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@sentry/mcp-server@latest"],
    env: {
      ...process.env,
      SENTRY_AUTH_TOKEN: config.sentry.authToken,
    } as Record<string, string>,
  });

  const client = new Client(
    { name: "bug-solver-bot", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  logger.info("✅ Connected to Sentry MCP server");

  // ---- Discover available tools -------------------------------------------
  const { tools: mcpTools } = await client.listTools();

  // Convert MCP tool schema → Anthropic tool format
  const anthropicTools: Anthropic.Tool[] = mcpTools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? `Sentry MCP tool: ${tool.name}`,
    input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
  }));

  logger.info(
    `Sentry MCP tools available (${anthropicTools.length}): ${anthropicTools.map((t) => t.name).join(", ")}`
  );

  // ---- Tool executor -------------------------------------------------------
  const callTool = async (
    name: string,
    input: Record<string, unknown>
  ): Promise<string> => {
    logger.info(`  🔧 MCP tool call: ${name}`, { input });

    try {
      const result = await client.callTool({ name, arguments: input });
      const content = result.content;

      if (Array.isArray(content)) {
        return content
          .map((c: unknown) => {
            const block = c as { type: string; text?: string };
            return block.type === "text" ? (block.text ?? "") : JSON.stringify(c);
          })
          .join("\n");
      }

      return JSON.stringify(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`MCP tool "${name}" failed: ${msg}`);
      return `Error calling ${name}: ${msg}`;
    }
  };

  // ---- Cleanup -------------------------------------------------------------
  const close = async (): Promise<void> => {
    try {
      await client.close();
      logger.info("Sentry MCP server connection closed");
    } catch {
      // Ignore close errors
    }
  };

  return { tools: anthropicTools, callTool, close };
}
