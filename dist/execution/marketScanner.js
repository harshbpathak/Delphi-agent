import { delphiClient } from './delphiClient.js';
const DEFAULT_TRADING_FEE = 0.005;
function parseTradingFee(raw) {
    if (!raw)
        return DEFAULT_TRADING_FEE;
    const n = Number(raw);
    if (!isFinite(n) || n <= 0)
        return DEFAULT_TRADING_FEE;
    // Fee may be expressed as a fraction (0.005), percent (0.5), bps (50),
    // or — as the competition SDK does — an 18-decimal fixed-point fraction
    // (5e15 = 0.5%).
    let fee;
    if (n <= 0.05)
        fee = n;
    else if (n <= 5)
        fee = n / 100;
    else if (n <= 10_000)
        fee = n / 10_000;
    else
        fee = n / 1e18;
    // Sanity clamp: no plausible trading fee exceeds 5%.
    return fee > 0 && fee <= 0.05 ? fee : DEFAULT_TRADING_FEE;
}
/**
 * Scans the Delphi competition for open markets, earliest settlement first,
 * fetching real on-chain prices, implied probabilities and resolution context.
 */
export async function scanOpenMarkets() {
    try {
        const { markets } = await delphiClient.listMarkets({
            status: "open",
            limit: 50,
            orderBy: "settles_at", // earliest settlement first → capital velocity
            pricesAndImpliedProbabilities: true,
        });
        if (!markets || markets.length === 0) {
            console.log("No open markets found.");
            return [];
        }
        const enriched = [];
        for (const m of markets) {
            if (!m.metadata || !m.metadata.question) {
                console.warn(`Skipping market ${m.id}: no metadata or question.`);
                continue;
            }
            if (!m.spotPrices || !m.spotImpliedProbabilities || m.spotPrices.length === 0) {
                console.warn(`Skipping market ${m.id}: no on-chain price data available.`);
                continue;
            }
            const outcomes = m.metadata.outcomes || ["Yes", "No"];
            // Only binary markets: the whole decision path (edge, direction flip,
            // Kelly) assumes two complementary outcomes.
            if (outcomes.length !== 2 || m.spotImpliedProbabilities.length !== 2) {
                console.warn(`Skipping market ${m.id}: not a binary market (${outcomes.length} outcomes).`);
                continue;
            }
            let dataSources = null;
            if (m.dataSources) {
                try {
                    dataSources = typeof m.dataSources === 'string'
                        ? m.dataSources
                        : JSON.stringify(m.dataSources);
                }
                catch { /* ignore */ }
            }
            enriched.push({
                address: m.id,
                question: m.metadata.question,
                outcomes,
                impliedProbabilities: m.spotImpliedProbabilities,
                spotPrices: m.spotPrices,
                category: m.category,
                settlesAt: m.settlesAt,
                resolvesAt: m.resolvesAt,
                createdAt: m.createdAt,
                resolutionContext: m.metadata.model?.prompt_context || null,
                dataSources,
                tradingFee: parseTradingFee(m.tradingFee),
                verifiable: m.verifiable,
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
