import { GoogleGenerativeAI } from '@google/generative-ai';
import { ScrapedArticle } from '../ingestion/rssScraper';
import * as dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.warn("GEMINI_API_KEY is not set. Gemini Oracle will return default values.");
}

const genAI = new GoogleGenerativeAI(apiKey || 'dummy');
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

/**
 * Uses the Gemini LLM to analyze scraped news articles and produce a
 * probability estimate for a prediction market question.
 *
 * The prompt is structured to force strict analytical reasoning —
 * the model must justify its answer with evidence from the articles
 * before outputting the final probability.
 */
export async function getGeminiProbability(
    marketQuestion: string,
    articles: ScrapedArticle[],
    currentImpliedProb: number,
    retries = 3
): Promise<{ probability: number; reasoning: string }> {
    if (articles.length === 0) {
        return { probability: currentImpliedProb, reasoning: "No new articles to analyze." };
    }

    const articleBlock = articles
        .slice(0, 15) // Cap at 15 articles to stay within context limits
        .map((a, i) => `[${i + 1}] "${a.title}" (${a.pubDate})\n    ${a.content}`)
        .join('\n\n');

    const prompt = `You are an expert quantitative analyst and prediction market trader.

MARKET QUESTION: "${marketQuestion}"
CURRENT MARKET IMPLIED PROBABILITY (YES): ${(currentImpliedProb * 100).toFixed(1)}%

Below are ${articles.length} recent news articles related to this market. Analyze them carefully.

ARTICLES:
${articleBlock}

TASK:
1. Identify which articles are directly relevant to the market question.
2. For each relevant article, determine if it supports YES or NO and how strongly (weak/moderate/strong).
3. Consider any conflicting signals.
4. Synthesize your analysis into a final probability estimate.

IMPORTANT RULES:
- Base your probability ONLY on the evidence in the articles above.
- If the evidence is mixed or inconclusive, stay close to the current market price of ${(currentImpliedProb * 100).toFixed(1)}%.
- If you have no clear edge, return the current market price.
- Be honest about uncertainty. Do not fabricate confidence.

Respond in this exact JSON format:
{
  "probability": <float between 0.0 and 1.0>,
  "reasoning": "<2-3 sentence summary of your analysis>"
}`;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const result = await model.generateContent({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: "application/json" }
            });
            const responseText = result.response.text();
            const data = JSON.parse(responseText);

            if (typeof data.probability === 'number' && data.probability >= 0 && data.probability <= 1) {
                console.log(`  [Gemini] Prob: ${data.probability.toFixed(4)}, Reasoning: ${data.reasoning}`);
                return {
                    probability: data.probability,
                    reasoning: data.reasoning || "No reasoning provided."
                };
            } else {
                throw new Error(`Invalid probability value from Gemini: ${data.probability}`);
            }
        } catch (error: any) {
            const isRateLimit = error?.status === 429 || error?.message?.includes('429');
            const isServerError = error?.status >= 500;

            if (attempt === retries) {
                console.error(`Gemini Oracle failed after ${retries} attempts. Returning market price as fallback.`);
                return { probability: currentImpliedProb, reasoning: "Gemini API unavailable. Returning market price." };
            }

            // Exponential backoff: 2s, 4s, 8s... with jitter
            const baseMs = Math.pow(2, attempt) * 1000;
            const jitter = Math.random() * 1000;
            const backoffMs = baseMs + jitter;

            if (isRateLimit) {
                console.warn(`Gemini rate limited (429). Backing off ${(backoffMs / 1000).toFixed(1)}s...`);
            } else if (isServerError) {
                console.warn(`Gemini server error (${error?.status}). Retrying in ${(backoffMs / 1000).toFixed(1)}s...`);
            } else {
                console.error(`Gemini error (attempt ${attempt}):`, error.message || error);
            }

            await delay(backoffMs);
        }
    }

    return { probability: currentImpliedProb, reasoning: "Exhausted retries." };
}
