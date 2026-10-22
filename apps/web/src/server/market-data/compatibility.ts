/** Why a provider cannot price this asset class, or null when it can. */
export function providerAssetIssue(
  providerId: string,
  assetClass: string | null | undefined,
  dataset?: string,
): string | null {
  if (assetClass === "option" && providerId !== "tastytrade")
    return "Option contract history is not supported by this connector yet. An underlying's candles cannot stand in for option prices.";
  if (assetClass == null) return null;
  if (["binance", "coinbase"].includes(providerId) && assetClass !== "crypto")
    return "This provider supplies spot crypto candles only. Choose a crypto trade.";
  if (providerId === "alpaca" && assetClass !== (dataset === "crypto" ? "crypto" : "equity"))
    return "Choose the Alpaca dataset that matches this trade's asset class.";
  if (providerId === "oanda" && !["forex", "cfd"].includes(assetClass))
    return "OANDA supports forex and CFD instruments.";
  if (providerId === "tastytrade" && !["equity", "option"].includes(assetClass))
    return "Tastytrade supplies US stock, index and equity-option candles.";
  return null;
}
