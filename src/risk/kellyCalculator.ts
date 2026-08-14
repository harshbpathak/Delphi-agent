export interface RiskGuardrails {
    /** Fractional Kelly scaling factor (e.g., 0.25 = quarter Kelly for conservative sizing) */
    fractionalKelly: number;
    /** Maximum % of bankroll to risk on any single trade (e.g., 0.05 = 5%) */
    maxSingleBetPct: number;
    /** Minimum NET edge (after fees/slippage) required to trigger a trade (e.g., 0.03 = 3%) */
    minEdgeThreshold: number;
    /** Minimum bankroll required to execute trades. Below this, trading halts. */
    minBankrollThreshold: number;
    /** Percentage of total bankroll that must be kept as liquid reserve (e.g., 0.40 = 40%) */
    reserveRatio: number;
}

export const DEFAULT_GUARDRAILS: RiskGuardrails = {
    fractionalKelly: 0.25,
    maxSingleBetPct: 0.08,        // Cap any single trade at 8% of bankroll (raised from 5% in chase mode)
    minEdgeThreshold: 0.02,       // Require at least 2% net edge (leader-style: more, smaller edges, fast recycling)
    minBankrollThreshold: 5.0,    // Stop trading completely if bankroll < 5 tokens
    reserveRatio: 0.15,           // Keep 15% liquid — leader-style deployment; idle cash earns nothing
};

/**
 * Net edge for buying an outcome: predicted probability minus the effective
 * cost per share including the trading fee. This is the number that must
 * clear minEdgeThreshold — a gross edge that disappears into fees and
 * slippage is not an edge.
 *
 * @param predictedProbability P(outcome wins), 0-1
 * @param effectivePricePerShare Actual cost per share from the quote (tokens/share), 0-1
 * @param tradingFee Fee as a fraction of trade cost (e.g. 0.005)
 */
export function netEdge(
    predictedProbability: number,
    effectivePricePerShare: number,
    tradingFee: number
): number {
    const effectiveCost = effectivePricePerShare * (1 + tradingFee);
    return predictedProbability - effectiveCost;
}

/**
 * Calculates position size (in TOKENS TO SPEND) using the Fractional Kelly
 * Criterion against the effective (fee-inclusive) price, with strict
 * bankruptcy guardrails.
 *
 * @param predictedProbability P(target outcome wins), 0-1
 * @param effectivePricePerShare Effective cost per share incl. slippage (tokens/share)
 * @param tradingFee Trading fee fraction (e.g. 0.005)
 * @param totalBankroll Total available wallet balance in tokens
 * @param guardrails Risk guardrails configuration
 * @returns Token budget to spend. 0 if edge is insufficient or guardrails fail.
 */
export function calculatePositionSize(
    predictedProbability: number,
    effectivePricePerShare: number,
    tradingFee: number,
    totalBankroll: number,
    guardrails: RiskGuardrails = DEFAULT_GUARDRAILS
): number {
    // Guardrail 1: Minimum Bankroll Threshold (Bankruptcy Protection)
    if (totalBankroll < guardrails.minBankrollThreshold) {
        console.warn(`[Risk Guardrail] Total bankroll (${totalBankroll.toFixed(2)}) is below minimum safety threshold (${guardrails.minBankrollThreshold}). Trading halted.`);
        return 0;
    }

    const effectiveCost = effectivePricePerShare * (1 + tradingFee);
    if (effectiveCost <= 0 || effectiveCost >= 1) {
        return 0; // A share can never pay more than 1 token — no positive-EV trade exists.
    }

    // Guardrail 2: Net Edge Requirement
    const edge = predictedProbability - effectiveCost;
    if (edge < guardrails.minEdgeThreshold) {
        return 0;
    }

    // Guardrail 3: Reserve Fund Allocation
    const allocatableBankroll = totalBankroll * (1.0 - guardrails.reserveRatio);

    // Kelly on the effective cost: a share bought at c pays 1 on a win.
    // Net decimal odds b = (1 - c) / c; f* = (bp - q) / b
    const b = (1.0 - effectiveCost) / effectiveCost;
    const p = predictedProbability;
    const q = 1.0 - p;
    const kellyPercentage = (b * p - q) / b;

    if (kellyPercentage <= 0) {
        return 0;
    }

    const rawBetSize = allocatableBankroll * kellyPercentage * guardrails.fractionalKelly;

    // Guardrail 4: Single-Trade Hard Cap — always on, no matter how certain
    // the model sounds ("anything can happen").
    const maxSingleBet = totalBankroll * guardrails.maxSingleBetPct;
    return Math.max(0, Math.min(rawBetSize, maxSingleBet));
}
