/** Format a raw token amount (integer string + decimals) into a short human string. */
export function humanAmount(raw: string, decimals: number, symbol = ""): string {
  const n = Number(raw) / Math.pow(10, decimals);
  let formatted: string;
  if (Math.abs(n) >= 1e9) formatted = (n / 1e9).toFixed(2) + "B";
  else if (Math.abs(n) >= 1e6) formatted = (n / 1e6).toFixed(2) + "M";
  else if (Math.abs(n) >= 1e3) formatted = (n / 1e3).toFixed(2) + "K";
  else if (Math.abs(n) >= 1) formatted = n.toFixed(4);
  else formatted = n.toFixed(8);
  return symbol ? formatted + " " + symbol : formatted;
}
