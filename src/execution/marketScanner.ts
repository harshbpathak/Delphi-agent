import { delphiClient } from './delphiClient';
import type { Market } from '@gensyn-ai/gensyn-delphi-sdk';

export interface EnrichedMarket {
    /** On-chain contract address */
    address: string;
    /** The prediction market question */
    question: string;
    /** The possible outcomes (e.g., ["Yes", "No"]) */
    outcomes: string[];
    /** Implied probability per outcome (0-1), from on-chain LMSR */
    impliedProbabilities: number[];
    /** Spot price per outcome */
    spotPrices: number[];
    /** The category (crypto, politics, sports, etc.) */
    category: string;
    /** When the market settles */
    settlesAt: string | null;
    /** When the market was created */
    createdAt: string;
    /** Raw SDK market object for anything else needed downstream */
    raw: Market;
}

/**
 * Scans the Delphi competition for open markets,
 * fetching real on-chain prices and implied probabilities.
 */
export async function scanOpenMarkets(): Promise<EnrichedMarket[]> {
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

        const enriched: EnrichedMarket[] = [];

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
    } catch (error) {
        console.error("Error scanning open markets:", error);
        return [];
    }
}
