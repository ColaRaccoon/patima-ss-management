/** Store summaries contain profit before the separately maintained fake-purchase deduction. */
export const calculateNetProfitAfterFakePurchase = (
  estimatedNetProfit: number | null,
  fakePurchaseAmount: number,
): number | null =>
  estimatedNetProfit == null ? null : estimatedNetProfit - fakePurchaseAmount;
