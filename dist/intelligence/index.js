import { getGeminiProbability } from './geminiOracle.js';
import { getPythonProbability } from './pythonOracle.js';
import { applyMarketConsensus } from './marketConsensus.js';
// Gemini (evidence + search + resolution-criteria reasoning) dominates.
// The Python service contributes a small on-chain flow signal at most —
// its features (buy pressure, momentum, headline sentiment) are weak
// evidence for literal resolution outcomes.
const GEMINI_WEIGHT = 0.85;
const PYTHON_MAX_WEIGHT = 0.15;
/**
 * Combines Gemini and Python ML predictions.
 * When Gemini reports the event is already concluded (post-deadline verification),
 * the flow-based Python signal is ignored entirely — the outcome is a fact,
 * not a forecast.
 */
export async function getCombinedProbability(market, articles, callGemini, flow = null) {
    const currentImpliedProb = market.impliedProbabilities[0];
    const marketContext = flow?.summary ?? null;
    const geminiInput = {
        question: market.question,
        outcomes: market.outcomes,
        category: market.category,
        currentImpliedProb,
        resolutionContext: market.resolutionContext,
        dataSources: market.dataSources,
        settlesAt: market.settlesAt,
        resolvesAt: market.resolvesAt,
        articles,
        marketContext,
    };
    const geminiPromise = callGemini
        ? getGeminiProbability(geminiInput)
        : Promise.resolve({
            probability: currentImpliedProb,
            reasoning: "Gemini daily budget exhausted — no LLM evaluation.",
            eventConcluded: false,
            ambiguity: 'none',
            deviationJustification: null,
        });
    const [geminiResult, pythonResult] = await Promise.all([
        geminiPromise,
        getPythonProbability(market.address, currentImpliedProb, market.question, articles.map(a => a.title)),
    ]);
    const geminiProb = geminiResult.probability;
    // 1. Our own view: Gemini, lightly adjusted by the on-chain flow signal.
    let rawProb = geminiProb;
    if (pythonResult !== null && !geminiResult.eventConcluded) {
        const pythonWeight = PYTHON_MAX_WEIGHT * Math.min(Math.max(pythonResult.confidence, 0), 1);
        const totalWeight = GEMINI_WEIGHT + pythonWeight;
        rawProb = (geminiProb * GEMINI_WEIGHT + pythonResult.probability * pythonWeight) / totalWeight;
        console.log(`  [Combined] Gemini: ${geminiProb.toFixed(4)} (w=${GEMINI_WEIGHT.toFixed(2)}) + Python: ${pythonResult.probability.toFixed(4)} (w=${pythonWeight.toFixed(2)}) = ${rawProb.toFixed(4)}`);
    }
    // 2. Shrink toward the crowd. 90 funded agents priced this too; a large
    //    disagreement is far more often our error than their blind spot.
    const hoursToResolve = (() => {
        const iso = market.resolvesAt || market.settlesAt;
        if (!iso)
            return null;
        const t = Date.parse(iso);
        return isNaN(t) ? null : (t - Date.now()) / 3600_000;
    })();
    const consensus = applyMarketConsensus({
        rawProb,
        marketProb: currentImpliedProb,
        hoursToResolve,
        trades24h: flow?.trades24h ?? 0,
        uniqueWallets24h: flow?.uniqueWallets24h ?? 0,
        eventConcluded: geminiResult.eventConcluded,
        ambiguity: geminiResult.ambiguity,
        hasJustification: geminiResult.deviationJustification !== null,
    });
    if (Math.abs(consensus.probability - rawProb) > 0.005) {
        console.log(`  [Consensus] ${consensus.note}`);
    }
    return {
        probability: consensus.probability,
        rawProb,
        geminiProb,
        pythonProb: pythonResult?.probability ?? null,
        reasoning: geminiResult.reasoning,
        // Only a clean verified fact counts as "concluded" downstream — that
        // flag unlocks larger sizing, so ambiguous criteria must not set it.
        eventConcluded: consensus.verifiedFact,
        ambiguity: geminiResult.ambiguity,
        weightOnMarket: consensus.weightOnMarket,
        consensusNote: consensus.note,
    };
}
