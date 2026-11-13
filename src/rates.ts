/** Aave compounds per-second. This is the same seconds-per-year the Aave UI uses. */
export const SECONDS_PER_YEAR = 31_536_000;

/**
 * `liquidityRate` / `variableBorrowRate` are RAY (1e27) APR-style rates.
 * Compounded APY matches the Aave UI and the official Aave MCP.
 * The linear `ray / 1e27 * 100` figure is APR and runs ~0.1 pp low.
 */
export function rayToApyNumber(raw: string | bigint | number): number {
  const ray = typeof raw === "bigint" ? Number(raw) : Number(raw);
  if (!Number.isFinite(ray) || ray <= 0) return 0;
  const apr = ray / 1e27;
  return (Math.pow(1 + apr / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1) * 100;
}

export function rayToAPY(raw: string | bigint | number, digits = 2): string {
  return rayToApyNumber(raw).toFixed(digits) + "%";
}

/** Linear APR percent, kept so callers can see the uncompounded ray. */
export function rayToAPR(raw: string | bigint | number, digits = 2): string {
  const ray = typeof raw === "bigint" ? Number(raw) : Number(raw);
  if (!Number.isFinite(ray) || ray <= 0) return (0).toFixed(digits) + "%";
  return ((ray / 1e27) * 100).toFixed(digits) + "%";
}
