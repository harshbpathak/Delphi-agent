import * as dotenv from 'dotenv';
dotenv.config();
import { initDatabase, getState, setState, getLastEvaluation, saveEvaluation, recordTrade, recordSettlement, recentSettledPnl, performanceSnapshot, openCostByCategory, } from './persistence/db.js';
import { scanOpenMarkets } from './execution/marketScanner.js';
import { scrapeNews, commitArticles } from './ingestion/rssScraper.js';
import { getCombinedProbability } from './intelligence/index.js';
import { calculatePositionSize, netEdge, DEFAULT_GUARDRAILS } from './risk/kellyCalculator.js';
import { postureAdjustedGuardrails } from './risk/riskPosture.js';
import { pollAllTrades, getMarketFlow, getCompetitionPosture } from './intelligence/marketContext.js';
import { logEvent } from './observability/eventLog.js';
import { startTelegram, notify } from './observability/telegram.js';
import { startDashboard } from './observability/dashboard.js';
import { getSlippageQuote } from './execution/quoteEngine.js';
import { executeTrade } from './execution/tradeExecutor.js';
import { delphiClient } from './execution/delphiClient.js';
import { LIQUIDATABLE_MARKET_STATUSES } from '@gensyn-ai/gensyn-delphi-sdk';
// ─── Operational & Rate Constraints ──────────────────────────────────────────
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between loop STARTS (no overlap: next loop is scheduled after the previous finishes)
const INTER_EVAL_DELAY_MS = 15_000; // Pause between Gemini evaluations (free tier RPM + grounding headroom)
const MAX_EVALS_PER_LOOP = 6; // Bound loop duration & Gemini usage per loop
const MAX_TRADES_PER_LOOP = 2; // Max trades per loop (anti-overtrading)
const MAX_DAILY_TRADES = 20; // Max trades per 24 hours
const MAX_DAILY_GEMINI_CALLS = 200; // Max Gemini API calls per 24 hours (free tier RPD headroom)
const MAX_SLIPPAGE_BPS = 200n; // 2% max slippage
const PRICE_MOVE_REEVAL_THRESHOLD = 0.03; // Re-evaluate a market if price moved 3% since last eval
const NEAR_SETTLE_REEVAL_MS = 36 * 3600_000; // Markets settling within 36h get re-evaluated at least hourly
const NEAR_SETTLE_REEVAL_INTERVAL_MS = 60 * 60 * 1000;
const CIRCUIT_BREAKER_LOOKBACK = 10; // Halt if the last N settled positions...
const CIRCUIT_BREAKER_MIN_SETTLED = 5; // ...(at least this many) lost more than...
const CIRCUIT_BREAKER_MAX_DRAWDOWN = 0.25; // ...25% of current bankroll
const MAX_CATEGORY_EXPOSURE_PCT = 0.15; // Max 15% of bankroll in open positions per category (correlation guard)
const TOKEN_DECIMALS = 6;
const DRY_RUN = process.env.DRY_RUN === 'true';
// Shared snapshots for the dashboard / Telegram providers
let lastMarkets = [];
let lastPosture = null;
let lastBankroll = 0;
let activeGuardrails = DEFAULT_GUARDRAILS;
// ─── Daily counters (persisted across restarts) ──────────────────────────────
let dailyTradeCount = 0;
let dailyGeminiCallCount = 0;
let lastResetTimestamp = Date.now();
async function loadCounters() {
    dailyTradeCount = Number(await getState('dailyTradeCount')) || 0;
    dailyGeminiCallCount = Number(await getState('dailyGeminiCallCount')) || 0;
    lastResetTimestamp = Number(await getState('lastResetTimestamp')) || Date.now();
}
async function persistCounters() {
    await setState('dailyTradeCount', String(dailyTradeCount));
    await setState('dailyGeminiCallCount', String(dailyGeminiCallCount));
    await setState('lastResetTimestamp', String(lastResetTimestamp));
}
async function checkAndResetDailyQuotas() {
    const elapsedHours = (Date.now() - lastResetTimestamp) / 3600_000;
    if (elapsedHours >= 24) {
        console.log(`\n🕒 24 hours elapsed. Resetting daily counters (Previous trades: ${dailyTradeCount}, Gemini calls: ${dailyGeminiCallCount}).`);
        dailyTradeCount = 0;
        dailyGeminiCallCount = 0;
        lastResetTimestamp = Date.now();
        await persistCounters();
    }
}
// ─── Keyword Extraction (supplemental RSS context for Gemini) ────────────────
function extractKeywords(question) {
    const stopPhrases = [
        'will', 'does', 'is', 'are', 'can', 'could', 'would', 'should',
        'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'by',
        'before', 'after', 'during', 'between', 'from', 'with',
        'yes', 'no', 'or', 'and', 'not', 'be', 'been', 'being',
        'this', 'that', 'these', 'those', 'it', 'its',
        'more', 'than', 'less', 'over', 'under', 'above', 'below',
    ];
    const words = question
        .replace(/[?!.,;:'"()[\]{}]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopPhrases.includes(w.toLowerCase()));
    return words.slice(0, 6).join(' ');
}
const delay = (ms) => new Promise(r => setTimeout(r, ms));
// ─── BigInt helpers ──────────────────────────────────────────────────────────
/** Convert a human share count to 18-decimal bigint without float overflow. */
function sharesToBigint(shares) {
    return BigInt(Math.round(shares * 1e6)) * 1000000000000n; // µshare precision → 18 decimals
}
function tokensFromBigint(v) {
    return Number(v) / 10 ** TOKEN_DECIMALS;
}
function sharesFromBigint(v) {
    return Number(v / 1000000000000n) / 1e6;
}
// ─── Sweep Settled Positions (also records realized PnL) ─────────────────────
async function sweepSettledPositions() {
    try {
        const signer = await delphiClient.getSigner();
        const { positions } = await delphiClient.listPositions({
            wallet: signer.address,
            redeemedOrLiquidated: false,
        });
        if (!positions || positions.length === 0)
            return;
        console.log(`\n🧹 Found ${positions.length} unredeemed positions. Sweeping...`);
        for (const pos of positions) {
            try {
                const status = await delphiClient.getMarketStatus(pos.marketProxy);
                if (status === 'settled') {
                    console.log(`  Redeeming settled market ${pos.marketProxy}...`);
                    const { tokensOut } = await delphiClient.redeemMarket({
                        marketAddress: pos.marketProxy,
                    });
                    const proceeds = tokensFromBigint(tokensOut);
                    await recordSettlement(pos.marketProxy, 'redeem', proceeds);
                    console.log(`  ✅ Redeemed! Tokens received: ${proceeds.toFixed(4)}`);
                    logEvent('REDEEM', `Redeemed ${pos.marketProxy}: +${proceeds.toFixed(2)} TST`);
                    await notify(`💰 Redeemed *${proceeds.toFixed(2)} TST* from settled market\n\`${pos.marketProxy}\``);
                }
                else if (LIQUIDATABLE_MARKET_STATUSES.includes(status)) {
                    console.log(`  Liquidating ${status} market ${pos.marketProxy}...`);
                    const { totalTokensOut } = await delphiClient.liquidate({
                        marketAddress: pos.marketProxy,
                        outcomeIndices: [0, 1],
                    });
                    const proceeds = tokensFromBigint(totalTokensOut);
                    await recordSettlement(pos.marketProxy, 'liquidate', proceeds);
                    console.log(`  ✅ Liquidated! Tokens received: ${proceeds.toFixed(4)}`);
                    logEvent('LIQUIDATE', `Liquidated ${status} market ${pos.marketProxy}: +${proceeds.toFixed(2)} TST`);
                    await notify(`♻️ Liquidated *${proceeds.toFixed(2)} TST* from ${status} market\n\`${pos.marketProxy}\``);
                }
            }
            catch (e) {
                console.error(`  Failed to process position ${pos.marketProxy}:`, e);
            }
        }
    }
    catch (e) {
        console.error("Sweep failed:", e);
    }
}
// ─── Circuit Breaker ─────────────────────────────────────────────────────────
/** Losing streaks are guaranteed even with a real edge; this distinguishes
 *  normal variance from "the model is broken" and halts on the latter. */
async function circuitBreakerTripped(bankroll) {
    if ((await getState('halted')) === '1') {
        console.warn(`🛑 CIRCUIT BREAKER is engaged. Trading halted. Restart with CLEAR_HALT=true after reviewing the trade journal.`);
        return true;
    }
    const { count, netPnl } = await recentSettledPnl(CIRCUIT_BREAKER_LOOKBACK);
    if (count >= CIRCUIT_BREAKER_MIN_SETTLED && netPnl <= -CIRCUIT_BREAKER_MAX_DRAWDOWN * bankroll) {
        await setState('halted', '1');
        console.error(`🛑 CIRCUIT BREAKER TRIPPED: last ${count} settled positions lost ${(-netPnl).toFixed(2)} tokens (> ${CIRCUIT_BREAKER_MAX_DRAWDOWN * 100}% of bankroll ${bankroll.toFixed(2)}). Trading halted until manually cleared (CLEAR_HALT=true).`);
        return true;
    }
    return false;
}
function hoursUntil(iso) {
    if (!iso)
        return null;
    const t = Date.parse(iso);
    return isNaN(t) ? null : (t - Date.now()) / 3600_000;
}
async function shouldEvaluate(market, articles) {
    const lastEval = await getLastEvaluation(market.address);
    if (!lastEval)
        return 'never evaluated';
    if (articles.length > 0)
        return `${articles.length} new articles`;
    const priceMove = Math.abs(market.impliedProbabilities[0] - lastEval.market_price);
    if (priceMove > PRICE_MOVE_REEVAL_THRESHOLD) {
        return `price moved ${(priceMove * 100).toFixed(1)}% since last evaluation`;
    }
    const hrs = hoursUntil(market.settlesAt);
    if (hrs !== null && hrs * 3600_000 < NEAR_SETTLE_REEVAL_MS
        && Date.now() - lastEval.evaluated_at > NEAR_SETTLE_REEVAL_INTERVAL_MS) {
        return `settles in ${hrs.toFixed(1)}h — periodic re-check`;
    }
    return null;
}
/** How long a stored evaluation may serve as a trade candidate without a fresh Gemini call. */
const EVAL_FRESHNESS_MS = 2 * 60 * 60 * 1000;
/** Build a candidate from a stored evaluation, re-priced at the CURRENT market price. */
function candidateFromStoredEval(market, predictedProb) {
    const currentImpliedProb = market.impliedProbabilities[0];
    const grossEdge = predictedProb - currentImpliedProb;
    const outcomeIdx = grossEdge > 0 ? 0 : 1;
    const effectiveProb = outcomeIdx === 0 ? predictedProb : 1 - predictedProb;
    const spotPrice = market.spotPrices[outcomeIdx] ?? (outcomeIdx === 0 ? currentImpliedProb : 1 - currentImpliedProb);
    const provisionalEdge = netEdge(effectiveProb, spotPrice, market.tradingFee);
    if (provisionalEdge < DEFAULT_GUARDRAILS.minEdgeThreshold)
        return null;
    return {
        market,
        prediction: {
            probability: predictedProb,
            geminiProb: predictedProb,
            pythonProb: null,
            reasoning: 'Cached recent evaluation, re-priced at current market price.',
            eventConcluded: false,
        },
        outcomeIdx, effectiveProb, spotPrice, provisionalEdge,
    };
}
async function evaluateMarkets(markets, guardrails) {
    const candidates = [];
    let evals = 0;
    let consecutiveGeminiFailures = 0;
    for (const market of markets) {
        if (evals >= MAX_EVALS_PER_LOOP)
            break;
        const keyword = extractKeywords(market.question);
        const articles = await scrapeNews(keyword);
        const reason = await shouldEvaluate(market, articles);
        if (!reason) {
            // No fresh evaluation needed — but a recent stored estimate may
            // still disagree with the current price enough to trade on.
            const lastEval = await getLastEvaluation(market.address);
            if (lastEval && Date.now() - lastEval.evaluated_at < EVAL_FRESHNESS_MS) {
                const cached = candidateFromStoredEval(market, lastEval.predicted_prob);
                if (cached) {
                    console.log(`📎 Cached candidate: "${market.question}" — net edge ${(cached.provisionalEdge * 100).toFixed(2)}% (evaluated ${((Date.now() - lastEval.evaluated_at) / 60000).toFixed(0)}m ago)`);
                    candidates.push(cached);
                }
            }
            continue;
        }
        if (dailyGeminiCallCount >= MAX_DAILY_GEMINI_CALLS) {
            console.warn(`⚠️  Daily Gemini budget exhausted (${MAX_DAILY_GEMINI_CALLS}). Deferring remaining evaluations to tomorrow.`);
            break;
        }
        console.log(`${'─'.repeat(60)}`);
        console.log(`📋 Evaluating: "${market.question}"`);
        console.log(`   ${market.address} | ${market.category} | settles ${market.settlesAt || '?'} | fee ${(market.tradingFee * 100).toFixed(2)}%`);
        console.log(`   Outcomes: "${market.outcomes[0]}" ${(market.impliedProbabilities[0] * 100).toFixed(1)}% / "${market.outcomes[1]}" ${(market.impliedProbabilities[1] * 100).toFixed(1)}%`);
        console.log(`   Trigger: ${reason}`);
        dailyGeminiCallCount++;
        await persistCounters();
        evals++;
        // Market Situation Engine: order flow + competitor crowding on this market
        const flow = await getMarketFlow(market.address);
        console.log(`   🌊 Flow: ${flow.summary}`);
        const prediction = await getCombinedProbability(market, articles, true, flow.summary);
        // Rate-limit bailout: a fallback answer means the Gemini call failed
        // after retries. Two in a row → the RPM window is saturated; stop
        // burning budget and let this loop trade on cached/fresh candidates.
        if (prediction.reasoning.includes('Gemini API unavailable')) {
            consecutiveGeminiFailures++;
            if (consecutiveGeminiFailures >= 2) {
                console.warn(`   ⚠️  Gemini rate-limited twice in a row — deferring remaining evaluations to next loop.`);
                break;
            }
            await delay(INTER_EVAL_DELAY_MS);
            continue; // article dedup NOT committed — news stays available for retry
        }
        consecutiveGeminiFailures = 0;
        await commitArticles(articles);
        const currentImpliedProb = market.impliedProbabilities[0];
        await saveEvaluation(market.address, prediction.probability, currentImpliedProb);
        const grossEdge = prediction.probability - currentImpliedProb;
        const outcomeIdx = grossEdge > 0 ? 0 : 1;
        const effectiveProb = outcomeIdx === 0 ? prediction.probability : 1 - prediction.probability;
        const spotPrice = market.spotPrices[outcomeIdx] ?? (outcomeIdx === 0 ? currentImpliedProb : 1 - currentImpliedProb);
        const provisionalEdge = netEdge(effectiveProb, spotPrice, market.tradingFee);
        console.log(`   🧠 P("${market.outcomes[0]}") = ${(prediction.probability * 100).toFixed(2)}% (market: ${(currentImpliedProb * 100).toFixed(2)}%)${prediction.eventConcluded ? ' [event concluded]' : ''}`);
        console.log(`   ⚡ Best side: "${market.outcomes[outcomeIdx]}" | provisional net edge: ${(provisionalEdge * 100).toFixed(2)}%`);
        console.log(`   💬 ${prediction.reasoning}`);
        logEvent('THINK', `"${market.question.slice(0, 70)}" → P=${(prediction.probability * 100).toFixed(1)}% vs mkt ${(currentImpliedProb * 100).toFixed(1)}% | edge ${(provisionalEdge * 100).toFixed(1)}% on "${market.outcomes[outcomeIdx]}" — ${prediction.reasoning.slice(0, 140)}`);
        if (provisionalEdge >= guardrails.minEdgeThreshold) {
            candidates.push({ market, prediction, outcomeIdx, effectiveProb, spotPrice, provisionalEdge });
        }
        else if (provisionalEdge > 0) {
            logEvent('SKIP', `"${market.question.slice(0, 60)}": edge ${(provisionalEdge * 100).toFixed(1)}% below ${(guardrails.minEdgeThreshold * 100).toFixed(0)}% threshold`);
        }
        await delay(INTER_EVAL_DELAY_MS);
    }
    return candidates;
}
// ─── Execution Phase ─────────────────────────────────────────────────────────
async function executeCandidate(c, bankroll, guardrails) {
    const { market, outcomeIdx } = c;
    const label = market.outcomes[outcomeIdx];
    // Correlation guard: cap open exposure per category.
    const exposure = await openCostByCategory();
    if ((exposure[market.category] || 0) >= bankroll * MAX_CATEGORY_EXPOSURE_PCT) {
        console.log(`   ⏭️  Category "${market.category}" already at max exposure (${(exposure[market.category] || 0).toFixed(1)} TST). Skipping.`);
        logEvent('SKIP', `"${market.question.slice(0, 60)}": ${market.category} exposure cap reached`);
        return 0;
    }
    // Provisional sizing at spot price to pick a probe share amount.
    const provisionalTokens = calculatePositionSize(c.effectiveProb, c.spotPrice, market.tradingFee, bankroll, guardrails);
    if (provisionalTokens <= 0) {
        console.log(`   ⏭️  Guardrails sized this trade to zero. Skipping.`);
        return 0;
    }
    let sharesOut = sharesToBigint(provisionalTokens / c.spotPrice);
    let tokensIn = await getSlippageQuote(market.address, outcomeIdx, sharesOut);
    if (!tokensIn) {
        console.warn(`   ❌ Quote failed. Skipping trade.`);
        return 0;
    }
    // Effective price per share from the actual quote (slippage included).
    let effectivePrice = tokensFromBigint(tokensIn) / sharesFromBigint(sharesOut);
    const edgeAfterSlippage = netEdge(c.effectiveProb, effectivePrice, market.tradingFee);
    if (edgeAfterSlippage < guardrails.minEdgeThreshold) {
        console.log(`   ⏭️  Slippage ate the edge (net ${(edgeAfterSlippage * 100).toFixed(2)}% at eff. price ${effectivePrice.toFixed(4)}). Skipping.`);
        logEvent('SKIP', `"${market.question.slice(0, 60)}": slippage cut edge to ${(edgeAfterSlippage * 100).toFixed(1)}%`);
        return 0;
    }
    // Re-size on the effective price; scale the order down if needed.
    const finalTokens = calculatePositionSize(c.effectiveProb, effectivePrice, market.tradingFee, bankroll, guardrails);
    if (finalTokens <= 0)
        return 0;
    const quotedCost = tokensFromBigint(tokensIn);
    if (quotedCost > finalTokens * 1.02) {
        const scale = finalTokens / quotedCost;
        sharesOut = sharesOut * BigInt(Math.round(scale * 1e6)) / 1000000n;
        tokensIn = await getSlippageQuote(market.address, outcomeIdx, sharesOut);
        if (!tokensIn) {
            console.warn(`   ❌ Re-quote failed. Skipping trade.`);
            return 0;
        }
        effectivePrice = tokensFromBigint(tokensIn) / sharesFromBigint(sharesOut);
    }
    const maxTokensIn = tokensIn * (10000n + MAX_SLIPPAGE_BPS) / 10000n;
    const costHuman = tokensFromBigint(tokensIn);
    const maxCostHuman = tokensFromBigint(maxTokensIn);
    // Hard safety cap — enforced against the worst-case (max slippage) spend.
    const maxAllowedSpend = bankroll * guardrails.maxSingleBetPct * (1 + Number(MAX_SLIPPAGE_BPS) / 10_000);
    if (maxCostHuman > maxAllowedSpend) {
        console.warn(`   ❌ Worst-case cost (${maxCostHuman.toFixed(4)}) exceeds hard cap (${maxAllowedSpend.toFixed(4)}). Skipping.`);
        return 0;
    }
    console.log(`   🎯 Buying "${label}": ${sharesFromBigint(sharesOut).toFixed(4)} shares @ eff. ${effectivePrice.toFixed(4)} = ${costHuman.toFixed(4)} tokens (max ${maxCostHuman.toFixed(4)})`);
    let txHash = null;
    if (DRY_RUN) {
        console.log(`   🏜️  DRY RUN — trade recorded to journal, not executed.`);
    }
    else {
        txHash = await executeTrade(market.address, outcomeIdx, sharesOut, maxTokensIn);
        if (!txHash)
            return 0;
    }
    logEvent('BUY', `${sharesFromBigint(sharesOut).toFixed(2)} "${label}" @ ${effectivePrice.toFixed(3)} (${costHuman.toFixed(2)} TST) — "${market.question.slice(0, 60)}" | P=${(c.effectiveProb * 100).toFixed(1)}% edge=${(edgeAfterSlippage * 100).toFixed(1)}%${DRY_RUN ? ' [DRY]' : ''}`);
    await notify(`${DRY_RUN ? '🏜️ DRY RUN' : '🚀 TRADE'}: bought *${sharesFromBigint(sharesOut).toFixed(2)}* shares of *"${label}"*\n` +
        `_${market.question.slice(0, 100)}_\n` +
        `Cost: ${costHuman.toFixed(2)} TST @ ${effectivePrice.toFixed(3)} | our P: ${(c.effectiveProb * 100).toFixed(1)}% | edge: ${(edgeAfterSlippage * 100).toFixed(1)}%`);
    await recordTrade({
        marketAddress: market.address,
        question: market.question,
        category: market.category,
        outcomeIdx,
        outcomeLabel: label,
        predictedProb: c.effectiveProb,
        marketPrice: c.spotPrice,
        effectivePrice,
        shares: sharesFromBigint(sharesOut),
        costTokens: costHuman,
        dryRun: DRY_RUN,
        txHash,
    });
    return costHuman;
}
// ─── Main Loop ───────────────────────────────────────────────────────────────
async function runLoop() {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`🔄 Trading Loop Started — ${new Date().toISOString()}${DRY_RUN ? ' [DRY RUN]' : ''}`);
    console.log(`${'═'.repeat(70)}`);
    await checkAndResetDailyQuotas();
    // 1. Sweep first — frees settled capital before sizing new trades, and
    //    keeps the realized-PnL journal current for the circuit breaker.
    await sweepSettledPositions();
    // 2. Bankroll
    let bankroll = 0;
    try {
        const balanceRaw = await delphiClient.getErc20Balance();
        bankroll = tokensFromBigint(balanceRaw);
        console.log(`💰 Available Bankroll: ${bankroll.toFixed(4)} tokens`);
    }
    catch (e) {
        console.error("❌ Could not fetch bankroll from network. Aborting loop.");
        return;
    }
    if (bankroll < DEFAULT_GUARDRAILS.minBankrollThreshold) {
        if (DRY_RUN) {
            console.log(`ℹ️  Bankroll below safety threshold. Using 100.0 test tokens for DRY RUN evaluation.`);
            bankroll = 100.0;
        }
        else {
            console.warn(`🛑 Bankroll (${bankroll.toFixed(2)}) below minimum threshold (${DEFAULT_GUARDRAILS.minBankrollThreshold}). Trading halted.`);
            return;
        }
    }
    lastBankroll = bankroll;
    // 3. Halt state (manual /halt from Telegram or dashboard) + circuit breaker
    if ((await getState('halted')) === '1') {
        console.warn(`🛑 Trading is HALTED (manual or circuit breaker). Sweeps continue; no new trades. /resume in Telegram or CLEAR_HALT=true to re-enable.`);
        return;
    }
    if (!DRY_RUN && await circuitBreakerTripped(bankroll)) {
        await notify('🛑 *CIRCUIT BREAKER TRIPPED* — trading halted. Review the journal and /resume when ready.');
        return;
    }
    if (dailyTradeCount >= MAX_DAILY_TRADES) {
        console.warn(`🛑 Daily trade limit reached (${dailyTradeCount}/${MAX_DAILY_TRADES}). Evaluations continue next loop.`);
        return;
    }
    // 4. Scan (earliest-settling first) + refresh the market-situation picture
    const markets = await scanOpenMarkets();
    lastMarkets = markets;
    const newTrades = await pollAllTrades();
    const posture = await getCompetitionPosture(markets);
    lastPosture = posture;
    activeGuardrails = postureAdjustedGuardrails(posture, bankroll);
    console.log(`📊 Found ${markets.length} open binary markets with live price data.`);
    console.log(`🌐 Situation: +${newTrades} new competitor trades indexed | ${posture.summary}`);
    console.log(`🎚️  Risk posture: fractional Kelly ${activeGuardrails.fractionalKelly} (rank-aware)`);
    console.log(`🔒 Daily Usage: Trades [${dailyTradeCount}/${MAX_DAILY_TRADES}] | Gemini [${dailyGeminiCallCount}/${MAX_DAILY_GEMINI_CALLS}]`);
    // 5. Evaluate → rank by net edge → execute the BEST candidates, not the
    //    first encountered ("act on your edges without cherry-picking").
    const candidates = await evaluateMarkets(markets, activeGuardrails);
    candidates.sort((a, b) => b.provisionalEdge - a.provisionalEdge);
    console.log(`\n🏁 ${candidates.length} candidate(s) clear the net-edge threshold.`);
    let loopTradesExecuted = 0;
    let liquidBankroll = bankroll;
    for (const c of candidates) {
        if (loopTradesExecuted >= MAX_TRADES_PER_LOOP)
            break;
        if (dailyTradeCount >= MAX_DAILY_TRADES)
            break;
        console.log(`\n▶ Executing candidate: "${c.market.question}" — net edge ${(c.provisionalEdge * 100).toFixed(2)}%`);
        const spent = await executeCandidate(c, liquidBankroll, activeGuardrails);
        if (spent > 0) {
            loopTradesExecuted++;
            dailyTradeCount++;
            liquidBankroll -= spent;
            await persistCounters();
        }
    }
    const perf = await performanceSnapshot();
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`✅ Loop finished. Trades: ${loopTradesExecuted}/${MAX_TRADES_PER_LOOP} this loop, ${dailyTradeCount}/${MAX_DAILY_TRADES} today.`);
    console.log(`📒 Journal: ${perf.totalTrades} live trades, ${perf.settled} settled, net PnL ${perf.netPnl.toFixed(4)} tokens.`);
    console.log(`⏳ Next loop in ${POLL_INTERVAL_MS / 1000}s...`);
    console.log(`${'═'.repeat(70)}\n`);
}
// ─── Holdings / status providers (Telegram + dashboard) ──────────────────────
async function getHoldings() {
    try {
        const signer = await delphiClient.getSigner();
        const { positions } = await delphiClient.listPositions({
            wallet: signer.address,
            redeemedOrLiquidated: false,
        });
        if (!positions)
            return [];
        return positions.map(pos => {
            const m = lastMarkets.find(mk => mk.address.toLowerCase() === pos.marketProxy.toLowerCase());
            const idx = Number(pos.outcomeIdx);
            const shares = Number(pos.shares) / 1e18;
            const price = m?.spotPrices[idx];
            return {
                market: pos.marketProxy,
                question: m?.question || pos.marketProxy,
                outcome: m?.outcomes[idx] || `outcome ${idx}`,
                shares,
                mark: price !== undefined ? shares * price : 0,
            };
        });
    }
    catch {
        return [];
    }
}
async function statusText() {
    const halted = (await getState('halted')) === '1';
    const perf = await performanceSnapshot();
    return `🤖 MHA status\n` +
        `State: ${halted ? '🛑 HALTED' : '🟢 ACTIVE'}${DRY_RUN ? ' (DRY RUN)' : ''}\n` +
        `Bankroll: ${lastBankroll.toFixed(2)} TST\n` +
        `Today: ${dailyTradeCount}/${MAX_DAILY_TRADES} trades, ${dailyGeminiCallCount}/${MAX_DAILY_GEMINI_CALLS} Gemini calls\n` +
        `Realized PnL: ${perf.netPnl.toFixed(2)} TST over ${perf.settled} settlements\n` +
        `Competition: ${lastPosture?.summary || 'no data yet'}`;
}
async function holdingsText() {
    const h = await getHoldings();
    if (h.length === 0)
        return 'No open positions.';
    const total = h.reduce((s, p) => s + p.mark, 0);
    return `📊 Holdings (mark ${total.toFixed(2)} TST)\n\n` +
        h.map(p => `• ${p.shares.toFixed(1)} × "${p.outcome}" ≈ ${p.mark.toFixed(2)} TST\n  ${p.question.slice(0, 70)}`).join('\n');
}
// ─── Entry Point ─────────────────────────────────────────────────────────────
async function main() {
    console.log(`
    ╔═════════════════════════════════════════════════════════╗
    ║   DELPHI AUTONOMOUS TRADING AGENT  v2                   ║
    ║   Gensyn Agent Arena — Competition                      ║
    ║   Probabilistic edge · Strict guardrails · Journaled    ║
    ╚═════════════════════════════════════════════════════════╝
    `);
    if (DRY_RUN) {
        console.log("⚠️  DRY RUN MODE ENABLED — No real trades will be executed.\n");
    }
    await initDatabase();
    await loadCounters();
    if (process.env.CLEAR_HALT === 'true') {
        await setState('halted', '0');
        console.log("🔓 Circuit breaker manually cleared via CLEAR_HALT=true.");
    }
    console.log("✅ SQLite database initialized (articles, journal, state, competitor intel).");
    // Phone control & visibility
    await startTelegram({ status: statusText, holdings: holdingsText });
    startDashboard({
        status: async () => ({
            bankroll: lastBankroll,
            trades: dailyTradeCount,
            halted: (await getState('halted')) === '1',
            dryRun: DRY_RUN,
        }),
        holdings: getHoldings,
        standings: async () => lastPosture ?? { summary: 'no data yet' },
    });
    // No-overlap scheduling: the next loop is armed only after this one ends.
    const schedule = async () => {
        try {
            await runLoop();
        }
        catch (e) {
            console.error("Loop crashed:", e);
        }
        setTimeout(schedule, POLL_INTERVAL_MS);
    };
    await schedule();
}
main().catch(console.error);
