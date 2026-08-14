/**
 * Periodic LLM strategy review — ADVISORY ONLY.
 *
 * Every 12h one Gemini call reviews the agent's full situation (standings,
 * book, realized performance, upcoming settlements) and produces at most
 * three concrete suggestions. They are logged and pushed to Telegram for the
 * human to act on — the model NEVER adjusts risk parameters itself. An LLM
 * tuning its own risk knobs is the failure mode this agent was rebuilt to
 * avoid.
 */
import { GoogleGenAI } from '@google/genai';
import { logEvent } from '../observability/eventLog.js';
import { notify } from '../observability/telegram.js';
import * as dotenv from 'dotenv';
dotenv.config();
const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: apiKey || 'dummy' });
export async function runStrategyReview(context) {
    if (!apiKey)
        return;
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: `You are the strategy advisor for MHA, an autonomous agent trading LMSR prediction markets in a PnL-ranked competition (top 3 win prizes). Its playbook: mid-band entries (0.35-0.80) on modest net edges, quote-first sizing at fractional Kelly, free-roll partial exits on winners, vol-scaled stop-losses, hard-data watchers on held positions, strict per-market/category caps.

CURRENT SITUATION:
${context}

Give AT MOST 3 concrete, specific suggestions for the next 12 hours — each one sentence, actionable, grounded in the numbers above (e.g. settlement clustering, category concentration, capital idle vs deployed, rank strategy). If the current course is right, say "stay the course" and why in one sentence. Plain text, no markdown, no preamble.`,
        });
        const advice = (response.text || '').trim().slice(0, 1200);
        if (!advice)
            return;
        console.log(`  [StrategyReview] ${advice.replace(/\n/g, ' | ')}`);
        logEvent('THINK', `STRATEGY REVIEW: ${advice.replace(/\n/g, ' | ')}`);
        await notify(`🧭 *12h Strategy Review*\n${advice}\n\n_Advisory only — no parameters were changed._`);
    }
    catch (e) {
        console.warn('  [StrategyReview] failed:', e.message?.slice(0, 120));
    }
}
