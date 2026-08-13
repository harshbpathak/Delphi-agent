import { getGeminiProbability } from './geminiOracle.js';
import { getPythonProbability } from './pythonOracle.js';
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
export async function getCombinedProbability(market, articles, callGemini, marketContext = null) {
    const currentImpliedProb = market.impliedProbabilities[0];
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
        });
    const [geminiResult, pythonResult] = await Promise.all([
        geminiPromise,
        getPythonProbability(market.address, currentImpliedProb, market.question, articles.map(a => a.title)),
    ]);
    const geminiProb = geminiResult.probability;
    if (pythonResult !== null && !geminiResult.eventConcluded) {
        const pythonWeight = PYTHON_MAX_WEIGHT * Math.min(Math.max(pythonResult.confidence, 0), 1);
        const totalWeight = GEMINI_WEIGHT + pythonWeight;
        const combined = (geminiProb * GEMINI_WEIGHT + pythonResult.probability * pythonWeight) / totalWeight;
        console.log(`  [Combined] Gemini: ${geminiProb.toFixed(4)} (w=${GEMINI_WEIGHT.toFixed(2)}) + Python: ${pythonResult.probability.toFixed(4)} (w=${pythonWeight.toFixed(2)}) = ${combined.toFixed(4)}`);
        return {
            probability: combined,
            geminiProb,
            pythonProb: pythonResult.probability,
            reasoning: geminiResult.reasoning,
            eventConcluded: false,
        };
    }
    return {
        probability: geminiProb,
        geminiProb,
        pythonProb: pythonResult?.probability ?? null,
        reasoning: geminiResult.reasoning,
        eventConcluded: geminiResult.eventConcluded,
    };
}
