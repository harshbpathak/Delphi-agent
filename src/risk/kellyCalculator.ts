/**
 * Calculates the optimal bet size using the Fractional Kelly Criterion.
 * 
 * @param predictedProbability Our agent's combined probability (e.g., 0.65)
 * @param currentMarketPrice The current implied probability / price (e.g., 0.55)
 * @param bankroll Current available capital to bet
 * @param fraction The Kelly fraction to use (e.g., 0.25 for quarter Kelly) to reduce variance
 * @returns The size of the bet. Returns 0 if there is no edge.
 */
export function calculatePositionSize(
    predictedProbability: number, 
    currentMarketPrice: number, 
    bankroll: number,
    fraction: number = 0.25
): number {
    // If we think it's less likely than the market, we shouldn't buy "YES" shares.
    // In a real system, we might buy "NO" shares, but for simplicity we only bet on YES if we have an edge.
    if (predictedProbability <= currentMarketPrice) {
        return 0; // No edge
    }

    // Odds format required for Kelly: Net decimal odds (b)
    // If implied prob is 0.55, the decimal odds are 1 / 0.55 = 1.818
    // The net odds (b) = decimal odds - 1 = 0.818
    const b = (1.0 / currentMarketPrice) - 1.0;
    const p = predictedProbability;
    const q = 1.0 - p;

    // Kelly Formula: f* = (bp - q) / b
    const kellyPercentage = (b * p - q) / b;

    if (kellyPercentage <= 0) {
        return 0; // Safety catch
    }

    // Apply Fractional Kelly
    const fractionalKelly = kellyPercentage * fraction;

    // Calculate actual bet amount
    const betSize = bankroll * fractionalKelly;

    // Optional: add a hard cap on maximum bet size
    const maxBet = bankroll * 0.1; // Never bet more than 10% of bankroll on a single trade
    
    return Math.min(betSize, maxBet);
}
