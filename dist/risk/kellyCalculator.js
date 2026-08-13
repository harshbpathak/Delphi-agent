export const DEFAULT_GUARDRAILS = {
    fractionalKelly: 0.25,
    maxSingleBetPct: 0.05, // Strictly cap any single trade at 5% of bankroll
    minEdgeThreshold: 0.03, // Require at least 3% edge
    minBankrollThreshold: 5.0, // Stop trading completely if bankroll < 5 tokens
    reserveRatio: 0.40, // Keep 40% of capital liquid, only risk from 60% allocatable pool
};
/**
 * Calculates position size using Fractional Kelly Criterion with strict bankruptcy guardrails.
 *
 * @param predictedProbability Combined predicted probability for the target outcome (0.0 to 1.0)
 * @param currentMarketPrice Implied market probability / price (0.0 to 1.0)
 * @param totalBankroll Total available wallet balance in tokens
 * @param guardrails Custom risk guardrails configuration
 * @returns Bet size in tokens. Returns 0 if edge is insufficient or guardrails fail.
 */
export function calculatePositionSize(predictedProbability, currentMarketPrice, totalBankroll, guardrails = DEFAULT_GUARDRAILS) {
    // Guardrail 1: Minimum Bankroll Threshold (Bankruptcy Protection)
    if (totalBankroll < guardrails.minBankrollThreshold) {
        console.warn(`[Risk Guardrail] Total bankroll (${totalBankroll.toFixed(2)}) is below minimum safety threshold (${guardrails.minBankrollThreshold}). Trading halted.`);
        return 0;
    }
    // Guardrail 2: Edge Requirement
    const edge = predictedProbability - currentMarketPrice;
    if (edge < guardrails.minEdgeThreshold) {
        return 0; // Insufficient edge
    }
    // Guardrail 3: Reserve Fund Allocation
    // Only trade with allocatable pool (e.g., 60% of total bankroll)
    const allocatableBankroll = totalBankroll * (1.0 - guardrails.reserveRatio);
    // Odds format required for Kelly: Net decimal odds (b)
    const b = (1.0 / currentMarketPrice) - 1.0;
    const p = predictedProbability;
    const q = 1.0 - p;
    // Kelly Formula: f* = (bp - q) / b
    const kellyPercentage = (b * p - q) / b;
    if (kellyPercentage <= 0) {
        return 0; // Negative edge catch
    }
    // Apply Fractional Kelly to allocatable pool
    const fractionalKelly = kellyPercentage * guardrails.fractionalKelly;
    const rawBetSize = allocatableBankroll * fractionalKelly;
    // Guardrail 4: Single-Trade Hard Cap
    const maxSingleBet = totalBankroll * guardrails.maxSingleBetPct;
    const finalBetSize = Math.min(rawBetSize, maxSingleBet);
    return Math.max(0, finalBetSize);
}
