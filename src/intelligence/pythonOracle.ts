import * as dotenv from 'dotenv';
dotenv.config();

const pythonServiceUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';

interface PythonPredictionResponse {
    probability: number;
    confidence: number;
    features_used: Record<string, unknown>;
    method: string;
}

/**
 * Calls the real Python ML service to get a probability prediction.
 * 
 * Sends the market address so the Python service can fetch live
 * subgraph trade data, along with the current implied probability
 * and any scraped news headlines for sentiment analysis.
 */
export async function getPythonProbability(
    marketAddress: string,
    currentImpliedProb: number,
    question: string,
    headlines: string[]
): Promise<{ probability: number; confidence: number } | null> {
    try {
        const response = await fetch(`${pythonServiceUrl}/predict`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(10_000),
            body: JSON.stringify({
                market_address: marketAddress,
                current_implied_prob: currentImpliedProb,
                question: question,
                headlines: headlines,
            })
        });

        if (!response.ok) {
            throw new Error(`Python service returned ${response.status}: ${response.statusText}`);
        }

        const data: PythonPredictionResponse = await response.json();
        console.log(`  [Python ML] Prob: ${data.probability.toFixed(4)}, Confidence: ${data.confidence.toFixed(4)}, Method: ${data.method}`);
        return { probability: data.probability, confidence: data.confidence };
    } catch (error: any) {
        const msg = error?.cause?.code || error?.message || String(error);
        console.warn(`  [Python ML] Service unavailable (${msg}) — continuing with Gemini only.`);
        return null;
    }
}
