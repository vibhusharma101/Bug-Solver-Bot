import winston from "winston";

const { combine, timestamp, colorize, printf, json } = winston.format;

// Human-readable format for local dev
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  printf(({ level, message, timestamp, ...meta }) => {
    const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    return `[${timestamp as string}] ${level}: ${message as string}${extra}`;
  })
);

// Structured JSON for production log aggregators (Datadog, BetterStack, etc.)
const prodFormat = combine(timestamp(), json());

const isProduction = process.env.NODE_ENV === "production";

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: isProduction ? prodFormat : devFormat,
  transports: [new winston.transports.Console()],
});
