export const TIMEOUTS = {
  serverStartupMs: 120_000,
  httpRequestMs: 30_000,
  agentStartupMs: 60_000,
  agentTurnMs: 180_000,
  mcpCallMs: 60_000,
  caseTotalMs: 300_000,
  runTotalMs: 30 * 60_000,
  gracefulShutdownMs: 15_000,
  healthPollMs: 500,
  turnPollMs: 500
} as const
