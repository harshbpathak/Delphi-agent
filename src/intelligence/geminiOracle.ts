import { GoogleGenAI } from '@google/genai';
import { ScrapedArticle } from '../ingestion/rssScraper.js';
import * as dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.warn("GEMINI_API_KEY is not set. Gemini Oracle will return default values.");
}

const ai = new GoogleGenAI({ apiKey: apiKey || 'dummy' });
const MODEL = "gemini-2.5-flash";

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

export interface GeminiMarketInput {
    question: string;
    /** Actual outcome labels, e.g. ["Yes","No"] or ["Over 2.5 goals","Under 2.5 goals"] */
    outcomes: string[];
    category: string;
    currentImpliedProb: number;
    /** Resolution/settlement context from market metadata, if available */
    resolutionContext: string | null;
    dataSources: string | null;
    settlesAt: string | null;
    resolvesAt: string | null;
    articles: ScrapedArticle[];
    /** Order-flow / competitor-crowding summary from the Market Situation Engine */
    marketContext?: string | null;
}

export interface GeminiPrediction {
    /** Probability that OUTCOME 0 wins */
    probability: number;
    reasoning: string;
    /** True when the model believes the underlying event outcome is already determined */
    eventConcluded: boolean;
}

function buildPrompt(input: GeminiMarketInput): string {
    const nowIso = new Date().toISOString();

    const articleBlock = input.articles.length > 0
        ? input.articles
            .slice(0, 15)
            .map((a, i) => `[${i + 1}] "${a.title}" (${a.pubDate})\n    ${a.content}`)
            .join('\n\n')
        : "(none provided — rely on search and base rates)";

    const criteriaBlock = input.resolutionContext
        ? `OFFICIAL RESOLUTION/SETTLEMENT CONTEXT (apply this LITERALLY — settlement is done by AI judges applying these rules as written):\n${input.resolutionContext}`
        : `No official resolution criteria were provided. INFER the likely resolution rules from the question. Prediction-market conventions: exact thresholds/margins/deadlines are applied literally; cancellation, postponement, or non-occurrence of the event typically resolves to the negative/second outcome.`;

    return `You are an expert quantitative analyst pricing a prediction market. Settlement on this platform is performed by AI arbitrators who apply the written resolution criteria LITERALLY, using publicly verifiable evidence.

CURRENT DATE AND TIME (UTC): ${nowIso}

MARKET QUESTION: "${input.question}"
OUTCOME 0: "${input.outcomes[0]}"
OUTCOME 1: "${input.outcomes[1]}"
CATEGORY: ${input.category}
MARKET IMPLIED PROBABILITY OF OUTCOME 0 ("${input.outcomes[0]}"): ${(input.currentImpliedProb * 100).toFixed(1)}%
QUESTION RESOLVES AT: ${input.resolvesAt || 'unknown'}
MARKET SETTLES AT: ${input.settlesAt || 'unknown'}

${criteriaBlock}

DECLARED SETTLEMENT DATA SOURCES: ${input.dataSources || 'unknown'}

ON-CHAIN MARKET SITUATION (other agents' order flow on this market — informative about crowding, NOT about the true outcome; agents herd and err):
${input.marketContext || 'no flow data'}

RECENT NEWS HEADLINES (may be incomplete or irrelevant):
${articleBlock}

TASK — work through these steps:
1. SCENARIO ENUMERATION: List every plausible outcome path (including edge cases: exact-threshold results, ties, cancellation, postponement, no official announcement in time) and which outcome each path pays under a literal reading of the rules.
2. TIME AWARENESS: Compare the current UTC time above against any deadline in the question.
   - If the deadline has ALREADY PASSED, the outcome is a matter of verifiable fact, not forecasting. Search for what actually happened and price near-certainty (0.95-0.99 in the confirmed direction). Set eventConcluded=true.
   - If the question is "will X happen before T" and time is running out with no scheduled/likely occurrence, probability must decay toward the no-occurrence side accordingly.
3. BASE RATES: For statistical questions (score margins, goal totals, temperature thresholds, price thresholds), start from historical base rates and distributions (e.g. league goal averages, climatological norms, asset volatility) and only adjust for concrete, specific evidence (announced lineups, weather forecasts, schedules). Headline TONE/sentiment is NOT evidence for quantitative questions.
4. SEARCH: Use search to find decisive current facts (forecasts, schedules, official announcements, injury reports) relevant to the resolution criteria.
5. SYNTHESIZE a final probability that OUTCOME 0 ("${input.outcomes[0]}") wins.

IMPORTANT RULES:
- If evidence is mixed, inconclusive or you have no clear edge, stay close to the current market price of ${(input.currentImpliedProb * 100).toFixed(1)}%.
- Be honest about uncertainty. Do not fabricate confidence.
- The probability MUST refer to OUTCOME 0 ("${input.outcomes[0]}"), not to "yes" in a colloquial sense.

Respond with ONLY a JSON object in exactly this format (no markdown fences, no extra text):
{"probability": <float 0.0-1.0>, "reasoning": "<2-3 sentence summary>", "eventConcluded": <true|false>}`;
}

function extractJson(text: string): any | null {
    // Model may wrap JSON in fences or prose; grab the first {...} block.
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}

async function callGemini(prompt: string, useGrounding: boolean): Promise<string> {
    const response = await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: useGrounding
            ? { tools: [{ googleSearch: {} }] }
            : { responseMimeType: "application/json" },
    });
    return response.text || '';
}

/**
 * Prices a market with Gemini. Tries a search-grounded call first (free-tier
 * grounding), falling back to an ungrounded JSON call, falling back to the
 * market price.
 */
export async function getGeminiProbability(
    input: GeminiMarketInput,
    retries = 3
): Promise<GeminiPrediction> {
    if (!apiKey) {
        return { probability: input.currentImpliedProb, reasoning: "No Gemini API key configured.", eventConcluded: false };
    }

    const prompt = buildPrompt(input);
    let useGrounding = true;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const responseText = await callGemini(prompt, useGrounding);
            const data = extractJson(responseText);

            if (data && typeof data.probability === 'number' && data.probability >= 0 && data.probability <= 1) {
                console.log(`  [Gemini${useGrounding ? '+search' : ''}] P(${input.outcomes[0]}): ${data.probability.toFixed(4)} | concluded: ${!!data.eventConcluded} | ${data.reasoning}`);
                return {
                    probability: data.probability,
                    reasoning: data.reasoning || "No reasoning provided.",
                    eventConcluded: !!data.eventConcluded,
                };
            }
            throw new Error(`Invalid/unparseable Gemini response: ${responseText.slice(0, 200)}`);
        } catch (error: any) {
            const msg = error?.message || String(error);
            const isRateLimit = error?.status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
            const isServerError = (error?.status >= 500) || msg.includes('500') || msg.includes('503');

            // If the grounded call is what failed (tool unsupported / quota), drop grounding.
            if (useGrounding && !isRateLimit && !isServerError) {
                console.warn(`  [Gemini] Grounded call failed (${msg.slice(0, 120)}). Retrying without search grounding.`);
                useGrounding = false;
                continue; // does not consume backoff
            }

            if (attempt === retries) {
                console.error(`Gemini Oracle failed after ${retries} attempts. Returning market price as fallback.`);
                return { probability: input.currentImpliedProb, reasoning: "Gemini API unavailable. Returning market price.", eventConcluded: false };
            }

            const backoffMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
            if (isRateLimit) {
                console.warn(`Gemini rate limited (429). Backing off ${(backoffMs / 1000).toFixed(1)}s...`);
            } else {
                console.warn(`Gemini error (attempt ${attempt}): ${msg.slice(0, 200)}. Retrying in ${(backoffMs / 1000).toFixed(1)}s...`);
            }
            await delay(backoffMs);
        }
    }

    return { probability: input.currentImpliedProb, reasoning: "Exhausted retries.", eventConcluded: false };
}
