# 🤖 Bug Solver Bot

An automated AI-powered bug-fixing service that runs **every day at 11 AM**, fetches the **top 5 unresolved Sentry issues**, asks **Claude** to generate code fixes, and creates **GitHub Pull Requests** for human review.

```
Sentry Issues → Claude AI → GitHub PR → Slack Notification
```

---

## Features

- ⏰ **Scheduled daily runs** at 11 AM (configurable cron)
- 🐛 **Fetches top 5 bugs** from Sentry by event frequency
- 🤖 **Claude AI** analyzes stack traces and generates targeted fixes
- 🔀 **Auto-creates GitHub PRs** with explanation in the PR body
- 💬 **Slack notifications** with one-click review buttons
- 🧪 **Dry-run mode** for testing without real API calls
- 🐳 **Docker-ready** for easy production deployment

---

## Quick Start

### 1. Clone and Install
```bash
git clone https://github.com/YOUR_ORG/bug-solver-bot.git
cd bug-solver-bot
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env and fill in all 4 required values:
#   ANTHROPIC_API_KEY, GITHUB_TOKEN, SENTRY_AUTH_TOKEN
#   GITHUB_OWNER, GITHUB_REPO, SENTRY_ORG, SENTRY_PROJECT
```

### 3. Run (Dev Mode)
```bash
# Start scheduler (waits for 11 AM)
npm run dev

# Trigger immediately (for testing)
npm run dev:trigger
```

---

## API Tokens Required

| Token | Service | Where to Get It |
|-------|---------|-----------------|
| `ANTHROPIC_API_KEY` | Claude AI | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| `GITHUB_TOKEN` | GitHub PAT | [github.com/settings/tokens](https://github.com/settings/tokens) — needs `repo` scope |
| `SENTRY_AUTH_TOKEN` | Sentry | [sentry.io/settings/account/api/auth-tokens](https://sentry.io/settings/account/api/auth-tokens/) — needs `project:read`, `event:read` |
| `SLACK_WEBHOOK_URL` | Slack (optional) | [api.slack.com/apps](https://api.slack.com/apps) → Incoming Webhooks |

---

## Project Structure

```
bug-solver-bot/
├── src/
│   ├── index.ts       # Entry point
│   ├── config.ts      # Env var validation
│   ├── logger.ts      # Winston logger
│   ├── sentry.ts      # Sentry API — fetch & parse top bugs
│   ├── github.ts      # GitHub API — fetch files, create PRs
│   ├── claude.ts      # Anthropic SDK — generate fixes
│   ├── agent.ts       # Orchestrator — wires everything together
│   ├── scheduler.ts   # node-cron daily scheduler
│   └── slack.ts       # Slack Block Kit notifications
├── .env.example       # Environment variable template
├── Dockerfile         # Multi-stage production image
├── docker-compose.yml # Docker Compose for deployment
└── tsconfig.json
```

---

## Production Deployment (Docker)

```bash
# Build and start
docker-compose up -d --build

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

### Deploying to a VPS (DigitalOcean / AWS EC2)

```bash
# 1. SSH into your server
ssh user@your-server-ip

# 2. Install Docker
curl -fsSL https://get.docker.com | sh

# 3. Clone the repo and configure
git clone https://github.com/YOUR_ORG/bug-solver-bot.git
cd bug-solver-bot
cp .env.example .env && nano .env

# 4. Start
docker-compose up -d --build
```

---

## Testing Without Real APIs

Enable dry-run mode in your `.env`:
```env
DRY_RUN=true
```

Then trigger immediately:
```bash
npm run dev:trigger
```

No Sentry/GitHub/Claude API calls will be made. The bot will just log what it *would* do.

---

## How the Bot Works

```
1. Scheduler fires at 11 AM (node-cron)
2. Fetches top 5 bugs from Sentry API (sorted by event count)
3. For each bug:
   a. Parses stack trace → finds source file
   b. Fetches file content from GitHub API
   c. Sends error + code to Claude → gets JSON fix response
   d. Creates branch: fix/sentry-{issueId}
   e. Commits the fixed file
   f. Opens a PR with Sentry link + Claude explanation
   g. Posts Slack message with review button
```

---

## Important: Human Review Policy

> ⚠️ **Never allow the bot to auto-merge to main.**

Set up branch protection in GitHub:
- Go to **Settings → Branches → Add branch protection rule**
- Pattern: `main`
- ✅ Require a pull request before merging
- ✅ Require at least 1 approval

The bot creates draft PRs that require human sign-off before any code reaches production.

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | ✅ | — | Claude API key |
| `GITHUB_TOKEN` | ✅ | — | GitHub Personal Access Token |
| `GITHUB_OWNER` | ✅ | — | GitHub org or username |
| `GITHUB_REPO` | ✅ | — | Target repository name |
| `GITHUB_BASE_BRANCH` | ❌ | `main` | Base branch for PRs |
| `SENTRY_AUTH_TOKEN` | ✅ | — | Sentry auth token |
| `SENTRY_ORG` | ✅ | — | Sentry org slug |
| `SENTRY_PROJECT` | ✅ | — | Sentry project slug |
| `SLACK_WEBHOOK_URL` | ❌ | — | Slack incoming webhook URL |
| `MAX_BUGS_PER_RUN` | ❌ | `5` | Number of bugs to fix per run |
| `CRON_SCHEDULE` | ❌ | `0 11 * * *` | Cron schedule for daily run |
| `DRY_RUN` | ❌ | `false` | If true, skip real API calls |
