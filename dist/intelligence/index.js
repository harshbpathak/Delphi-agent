import { getGeminiProbability } from './geminiOracle';
import { getPythonProbability } from './pythonOracle';
/**
 * Combines predictions from Gemini NLP and Python ML service.
 *
 * Uses a weighted average:
 * - If the Python ML service returns a high confidence, weight it more.
 * - If the Python ML service is down, fall back to Gemini only.
 * - If Gemini is down (returns market price), and Python is up, use Python only.
 */
export async function getCombinedProbability(marketAddress, marketQuestion, articles, currentImpliedProb) {
    // Run both intelligence engines in parallel
    const [geminiResult, pythonResult] = await Promise.all([
        getGeminiProbability(marketQuestion, articles, currentImpliedProb),
        getPythonProbability(marketAddress, currentImpliedProb, marketQuestion, articles.map(a => a.title)),
    ]);
    const geminiProb = geminiResult.probability;
    const reasoning = geminiResult.reasoning;
    if (pythonResult !== null) {
        const pythonProb = pythonResult.probability;
        const pythonConf = pythonResult.confidence;
        // Weighted average: Python gets more weight if it's confident.
        // Base weights: 60% Gemini (LLM is generally more capable), 40% Python ML.
        // Adjust Python weight by its confidence.
        const geminiWeight = 0.6;
        const pythonWeight = 0.4 * (0.5 + pythonConf * 0.5); // Scale 0.2 to 0.4 based on confidence
        const totalWeight = geminiWeight + pythonWeight;
        const combined = (geminiProb * geminiWeight + pythonProb * pythonWeight) / totalWeight;
        console.log(`  [Combined] Gemini: ${geminiProb.toFixed(4)} (w=${geminiWeight.toFixed(2)}) + Python: ${pythonProb.toFixed(4)} (w=${pythonWeight.toFixed(2)}) = ${combined.toFixed(4)}`);
        return {
            probability: combined,
            geminiProb,
            pythonProb,
            reasoning,
            pythonConfidence: pythonConf,
        };
    }
    else {
        console.warn("  Python ML service unavailable. Using Gemini only.");
        return {
            probability: geminiProb,
            geminiProb,
            pythonProb: null,
            reasoning,
            pythonConfidence: null,
        };
    }
}
