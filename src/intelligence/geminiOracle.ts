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
    /** Whether the resolution criteria admit conflicting readings */
    ambiguity: 'none' | 'minor' | 'severe';
    /** The specific verifiable fact the market appears to be missing (null if none) */
    deviationJustification: string | null;
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

THE MARKET PRICE IS EVIDENCE, NOT A TARGET.
That ${(input.currentImpliedProb * 100).toFixed(1)}% is the aggregated judgement of ~90 competing trading agents, most of them LLM-driven with web search, all reading the same public information and betting real stakes on being right. When your estimate disagrees sharply with theirs, the overwhelmingly likely explanation is that YOU have misread something — not that 90 funded agents all missed an obvious fact. Treat a large disagreement as a red flag to re-examine your reasoning, not as a discovered edge.
You may only override the crowd decisively when you can name a SPECIFIC, VERIFIABLE, PUBLIC fact that settles the question and that the price clearly does not reflect. If you cannot name that fact in one sentence, you do not have an edge — stay near the market price.

TASK — work through these steps:
1. READ THE RULES IN PRECEDENCE ORDER. Clarifications, definitions and exclusions OVERRIDE the headline question and the summary clauses. If a clause says "announced or available" but a clarification defines the term as requiring availability, or excludes internal/rumored/unreleased items, THE CLARIFICATION WINS. Quote the controlling clause to yourself before deciding.
2. AMBIGUITY CHECK (critical). Ask: could two careful arbitrators reading these exact criteria reach OPPOSITE verdicts on the known facts?
   - "severe" = the clauses genuinely conflict, or the outcome turns on interpreting a word (e.g. "release" vs "announce") rather than on any fact.
   - "minor" = mostly clear, one secondary term is fuzzy.
   - "none" = any competent arbitrator reaches the same verdict.
   When ambiguity is "severe", knowing the facts does NOT make you confident — the uncertainty has moved from the world into the wording. Your probability must reflect that, and must stay close to the market price.
3. SCENARIO ENUMERATION: List every plausible outcome path (exact-threshold results, ties, cancellation, postponement, no official announcement in time) and which outcome each pays under a literal reading.
4. TIME AWARENESS: Compare current UTC time against any deadline.
   - Deadline ALREADY PASSED and criteria unambiguous → the outcome is verifiable fact; search for what happened and price near-certainty. Set eventConcluded=true.
   - Deadline PASSED but criteria ambiguous → eventConcluded=true, ambiguity="severe", and stay near the market: the facts are settled, the verdict is not.
   - "Will X happen before T" with little time left and no scheduled occurrence → decay toward the no-occurrence side.
   - Note: little time remaining also means the market has had maximum opportunity to price everything public. Late, large disagreements are usually errors.
5. BASE RATES: For statistical questions (margins, goal totals, temperature and price thresholds), start from historical base rates and distributions, adjusting only for concrete evidence (lineups, forecasts, schedules). Headline TONE is NOT evidence.
6. SEARCH for decisive current facts relevant to the controlling clause.
7. SYNTHESIZE a probability that OUTCOME 0 ("${input.outcomes[0]}") wins.

CALIBRATION RULES:
- Reserve probabilities above 0.90 or below 0.10 for outcomes that are already determined AND governed by unambiguous criteria.
- If evidence is mixed, inconclusive, or the criteria are ambiguous, stay close to ${(input.currentImpliedProb * 100).toFixed(1)}%.
- Be honest about uncertainty. Do not fabricate confidence.
- The probability MUST refer to OUTCOME 0 ("${input.outcomes[0]}"), not to "yes" colloquially.

Respond with ONLY a JSON object in exactly this format (no markdown fences, no extra text):
{"probability": <float 0.0-1.0>, "reasoning": "<2-3 sentences, naming the controlling clause>", "eventConcluded": <true|false>, "ambiguity": "none"|"minor"|"severe", "deviationJustification": "<one sentence naming the specific public fact the market is missing, or null if you have no such fact>"}`;
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
        return { probability: input.currentImpliedProb, reasoning: "No Gemini API key configured.", eventConcluded: false, ambiguity: "none", deviationJustification: null };
    }

    const prompt = buildPrompt(input);
    let useGrounding = true;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const responseText = await callGemini(prompt, useGrounding);
            const data = extractJson(responseText);

            if (data && typeof data.probability === 'number' && data.probability >= 0 && data.probability <= 1) {
                const ambiguity: GeminiPrediction['ambiguity'] =
                    data.ambiguity === 'severe' || data.ambiguity === 'minor' ? data.ambiguity : 'none';
                const justification = typeof data.deviationJustification === 'string'
                    && data.deviationJustification.trim().length > 0
                    && data.deviationJustification.trim().toLowerCase() !== 'null'
                        ? data.deviationJustification.trim()
                        : null;
                console.log(`  [Gemini${useGrounding ? '+search' : ''}] P(${input.outcomes[0]}): ${data.probability.toFixed(4)} | concluded: ${!!data.eventConcluded} | ambiguity: ${ambiguity} | ${data.reasoning}`);
                if (justification) console.log(`  [Gemini] Claimed edge: ${justification}`);
                return {
                    probability: data.probability,
                    reasoning: data.reasoning || "No reasoning provided.",
                    eventConcluded: !!data.eventConcluded,
                    ambiguity,
                    deviationJustification: justification,
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
                return { probability: input.currentImpliedProb, reasoning: "Gemini API unavailable. Returning market price.", eventConcluded: false, ambiguity: "none", deviationJustification: null };
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

    return { probability: input.currentImpliedProb, reasoning: "Exhausted retries.", eventConcluded: false, ambiguity: "none", deviationJustification: null };
}
