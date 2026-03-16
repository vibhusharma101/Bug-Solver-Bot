import dotenv from "dotenv";
dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
        `Please copy .env.example to .env and fill in all values.`
    );
  }
  return value.trim();
}

function optionalEnv(name: string, defaultValue = ""): string {
  return (process.env[name] ?? defaultValue).trim();
}

export const config = {
  anthropic: {
    apiKey: requireEnv("ANTHROPIC_API_KEY"),
    model: "claude-3-haiku-20240307",
  },
  github: {
    token: requireEnv("GITHUB_TOKEN"),
    owner: requireEnv("GITHUB_OWNER"),
    repo: requireEnv("GITHUB_REPO"),
    baseBranch: optionalEnv("GITHUB_BASE_BRANCH", "main"),
  },
  sentry: {
    authToken: requireEnv("SENTRY_AUTH_TOKEN"),
    org: requireEnv("SENTRY_ORG"),
    project: requireEnv("SENTRY_PROJECT"),
  },
  slack: {
    webhookUrl: optionalEnv("SLACK_WEBHOOK_URL"),
  },
  bot: {
    maxBugsPerRun: parseInt(optionalEnv("MAX_BUGS_PER_RUN", "5"), 10),
    cronSchedule: optionalEnv("CRON_SCHEDULE", "0 11 * * *"),
    dryRun: optionalEnv("DRY_RUN", "false") === "true",
  },
};

export type Config = typeof config;
