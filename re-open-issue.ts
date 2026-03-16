import { McpBridge } from './src/mcp.js';
import { config } from './src/config.js';
import { logger } from './src/logger.js';

async function main() {
    const mcp = new McpBridge();
    try {
        await mcp.connect();
        logger.info('Connected to MCP. Re-opening issue...');
        
        await mcp.callTool('update_issue', {
            organizationSlug: config.sentry.org,
            issueId: 'GIT-VISUALISER-1',
            status: 'unresolved'
        });
        
        logger.info('✅ Issue GIT-VISUALISER-1 in Sentry is now UNRESOLVED.');
    } catch (err) {
        logger.error('Failed to re-open issue', err);
    } finally {
        await mcp.disconnect();
    }
}

main();
