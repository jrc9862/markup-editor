import { pino } from 'pino';

/**
 * Structured logger (Phase 2 observability). JSON by default — the shape an
 * aggregator (Loki/CloudWatch/Datadog) expects. In non-production we try the
 * `pino-pretty` transport for readable dev output, falling back to JSON if it
 * isn't installed (it's an optional dev-only nicety, not a runtime dep).
 */
const level = process.env.LOG_LEVEL ?? 'info';
const pretty =
  process.env.NODE_ENV !== 'production' && process.env.LOG_PRETTY !== '0';

function build() {
  if (pretty) {
    try {
      return pino({
        level,
        transport: { target: 'pino-pretty', options: { translateTime: true } },
      });
    } catch {
      // pino-pretty not available — fall through to JSON.
    }
  }
  return pino({ level });
}

export const logger = build();
