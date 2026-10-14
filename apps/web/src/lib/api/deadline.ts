export function remainingSeconds(deadline: string, serverClockOffset = 0, now = Date.now()): number {
  const remaining = (Date.parse(deadline) - now - serverClockOffset) / 1000;
  return Number.isFinite(remaining) ? Math.max(0, Math.ceil(remaining)) : 0;
}
