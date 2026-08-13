import { delphiClient } from './delphiClient';
/**
 * Scans the Delphi competition for open markets,
 * fetching real on-chain prices and implied probabilities.
 */
export async function scanOpenMarkets() {
    try {
        const { markets } = await delphiClient.listMarkets({
            status: "open",
            limit: 20,
            pricesAndImpliedProbabilities: true, // Real on-chain LMSR prices
        });
        if (!markets || markets.length === 0) {
            console.log("No open markets found.");
            return [];
        }
        const enriched = [];
        for (const m of markets) {
            // Skip markets with no metadata (malformed/unparseable)
            if (!m.metadata || !m.metadata.question) {
                console.warn(`Skipping market ${m.id}: no metadata or question.`);
                continue;
            }
            // Skip markets with no price data (shouldn't happen with the flag, but be safe)
            if (!m.spotPrices || !m.spotImpliedProbabilities || m.spotPrices.length === 0) {
                console.warn(`Skipping market ${m.id}: no on-chain price data available.`);
                continue;
            }
            enriched.push({
                address: m.id,
                question: m.metadata.question,
                outcomes: m.metadata.outcomes || ["Yes", "No"],
                impliedProbabilities: m.spotImpliedProbabilities,
                spotPrices: m.spotPrices,
                category: m.category,
                settlesAt: m.settlesAt,
                createdAt: m.createdAt,
                raw: m,
            });
        }
        return enriched;
    }
    catch (error) {
        console.error("Error scanning open markets:", error);
        return [];
    }
}
