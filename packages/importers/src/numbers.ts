/** "$1,234.56", "(45.20)", "1 234,56", "-12.5" → number. NaN when unparseable. */
export const parseMoney = (value: string | undefined): number => {
  if (value === undefined) return NaN;
  let text = value.trim();
  if (text === "") return NaN;
  // Combined value columns (Webull's "Price/Avg Price" → "185.50/186.00"):
  // the average fill price is the second segment.
  const combined = text.match(/^(-?[\d.,]+)\/(-?[\d.,]+)$/);
  if (combined) text = combined[2]!;
  text = text.replace(/[$€£\s]/g, "");
  const parenthesized = text.startsWith("(") && text.endsWith(")");
  if (parenthesized) text = text.slice(1, -1);
  // Keep conventional grouping in "1,234", while allowing fractional amounts
  // such as "0,125", "1,09375" and "1.234,56789".
  if (/^[+-]?[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/.test(text)) {
    text = text.replaceAll(",", "");
  } else if (/^[+-]?\d{1,3}(\.\d{3})+,\d+$/.test(text)) {
    text = text.replaceAll(".", "").replace(",", ".");
  } else if (/^[+-]?\d+,\d+$/.test(text)) {
    text = text.replace(",", ".");
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return NaN;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return NaN;
  return parenthesized ? -Math.abs(parsed) : parsed;
};

export const parseQuantity = (value: string | undefined): number => {
  if (value === undefined) return NaN;
  let text = value.trim();
  // Combined quantity columns (Webull's "Filled/Total Qty" → "5/10"):
  // the FILLED amount is the first segment.
  const combined = text.match(/^(-?[\d.,]+)\/(-?[\d.,]+)$/);
  if (combined) text = combined[1]!;
  const parsed = parseMoney(text);
  return Number.isNaN(parsed) ? NaN : Math.abs(parsed);
};
