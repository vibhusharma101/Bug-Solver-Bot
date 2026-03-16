import axios from "axios";
import { config } from "./config.js";
import { logger } from "./logger.js";

export interface SlackMessage {
  issueShortId: string;
  issueTitle: string;
  sentryPermalink: string;
  prUrl: string;
  prNumber: number;
  explanation: string;
  filePath: string;
  success: boolean;
  errorReason?: string;
}

/** Post a Slack notification about a fix attempt. No-ops if webhook is not configured. */
export async function notifySlack(msg: SlackMessage): Promise<void> {
  if (!config.slack.webhookUrl) return;

  const blocks = msg.success
    ? buildSuccessBlocks(msg)
    : buildFailureBlocks(msg);

  try {
    await axios.post(config.slack.webhookUrl, { blocks });
    logger.info(`Slack notification sent for ${msg.issueShortId}`);
  } catch (err) {
    // Never let Slack failures block the main flow
    logger.warn(`Failed to send Slack notification`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---- Slack Block Kit builders ---------------------------------------------

function buildSuccessBlocks(msg: SlackMessage) {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "🤖 Bug Solver Bot — Fix Ready for Review",
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Sentry Issue:*\n<${msg.sentryPermalink}|${msg.issueShortId}>` },
        { type: "mrkdwn", text: `*File Fixed:*\n\`${msg.filePath}\`` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Error:* ${msg.issueTitle}\n\n*Claude's Explanation:*\n${msg.explanation}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "👀 Review PR", emoji: true },
          style: "primary",
          url: msg.prUrl,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🐛 View in Sentry", emoji: true },
          url: msg.sentryPermalink,
        },
      ],
    },
    { type: "divider" },
  ];
}

function buildFailureBlocks(msg: SlackMessage) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `⚠️ *Bug Solver Bot* could not fix *<${msg.sentryPermalink}|${msg.issueShortId}>*\n*Reason:* ${msg.errorReason ?? "Unknown error"}`,
      },
    },
  ];
}
