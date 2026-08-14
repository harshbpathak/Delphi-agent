import * as dotenv from 'dotenv';
dotenv.config();
import { initDatabase, getState, setState, getLastEvaluation, saveEvaluation, recordTrade, recordSettlement, recentSettledPnl, performanceSnapshot, openCostByCategory, getOpenEntry, performanceStats, settlementExists, getOpenCost, recordPriceSnapshots, } from './persistence/db.js';
import { scanOpenMarkets } from './execution/marketScanner.js';
import { scrapeNews, commitArticles } from './ingestion/rssScraper.js';
import { getCombinedProbability } from './intelligence/index.js';
import { calculatePositionSize, netEdge, DEFAULT_GUARDRAILS } from './risk/kellyCalculator.js';
import { postureAdjustedGuardrails } from './risk/riskPosture.js';
import { pollAllTrades, getMarketFlow, getCompetitionPosture } from './intelligence/marketContext.js';
import { selfCalibrate } from './maintenance/selfCalibrate.js';
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
const MAX_TRADES_PER_LOOP = 3; // Max trades per loop (anti-overtrading)
const MAX_DAILY_TRADES = 30; // Max trades per 24 hours (leader averages ~25 events/day)
const MAX_DAILY_GEMINI_CALLS = 200; // Max Gemini API calls per 24 hours (free tier RPD headroom)
const MAX_SLIPPAGE_BPS = 200n; // 2% max slippage
const PRICE_MOVE_REEVAL_THRESHOLD = 0.03; // Re-evaluate a market if price moved 3% since last eval
const NEAR_SETTLE_REEVAL_MS = 36 * 3600_000; // Markets settling within 36h get re-evaluated at least hourly
const NEAR_SETTLE_REEVAL_INTERVAL_MS = 60 * 60 * 1000;
const CIRCUIT_BREAKER_LOOKBACK = 10; // Halt if the last N settled positions...
const CIRCUIT_BREAKER_MIN_SETTLED = 5; // ...(at least this many) lost more than...
const CIRCUIT_BREAKER_MAX_DRAWDOWN = 0.25; // ...25% of current bankroll
const MAX_CATEGORY_EXPOSURE_PCT = 0.25; // Max 25% of bankroll in open positions per category (correlation guard)
const MAX_MARKET_EXPOSURE_PCT = 0.20; // Max 20% of bankroll in ONE market — allows leader-style scale-ins, bounded
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
/** Start of the current Gemini free-tier quota day: midnight Pacific (07:00 UTC
 *  during PDT). Aligning our counters to Google's window means we never sit
 *  blocked on a stale local counter while the provider quota is actually fresh. */
function currentQuotaWindowStart() {
    const start = new Date();
    start.setUTCHours(7, 0, 0, 0);
    if (start.getTime() > Date.now())
        start.setUTCDate(start.getUTCDate() - 1);
    return start.getTime();
}
async function checkAndResetDailyQuotas() {
    const windowStart = currentQuotaWindowStart();
    if (lastResetTimestamp < windowStart) {
        console.log(`\n🕒 New quota day (07:00 UTC). Resetting daily counters (Previous trades: ${dailyTradeCount}, Gemini calls: ${dailyGeminiCallCount}).`);
        dailyTradeCount = 0;
        dailyGeminiCallCount = 0;
        lastResetTimestamp = windowStart;
        await persistCounters();
    }
}
/** Paced Gemini budget: the daily allowance is released smoothly over the
 *  24h window (plus a 20-call burst headroom) so one busy morning can't
 *  leave the agent evaluation-blind all evening. */
function pacedGeminiBudget() {
    const hoursIn = Math.max(0, (Date.now() - lastResetTimestamp) / 3600_000);
    return Math.min(MAX_DAILY_GEMINI_CALLS, Math.ceil(MAX_DAILY_GEMINI_CALLS * hoursIn / 24) + 20);
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
                    // A settled market we hold the LOSING side of pays nothing and
                    // redeem() reverts. Journal the loss once, then leave it alone —
                    // otherwise the loss never reaches the circuit breaker or the
                    // calibration gate, and the sweep retries it every loop forever.
                    let winningIdx = null;
                    try {
                        const m = await delphiClient.getMarket({ id: pos.marketProxy });
                        winningIdx = m.winningOutcomeIdx === null ? null : Number(m.winningOutcomeIdx);
                    }
                    catch { /* unknown winner → fall through and attempt redeem */ }
                    if (winningIdx !== null && Number(pos.outcomeIdx) !== winningIdx) {
                        if (await settlementExists(pos.marketProxy))
                            continue; // already journalled
                        const lostCost = await getOpenCost(pos.marketProxy);
                        await recordSettlement(pos.marketProxy, 'loss', 0);
                        const shares = Number(pos.shares) / 1e18;
                        console.log(`  ❌ Lost market ${pos.marketProxy}: ${shares.toFixed(2)} shares of outcome ${pos.outcomeIdx} expired worthless (winner was ${winningIdx}). Cost ${lostCost.toFixed(2)} TST written off.`);
                        logEvent('SKIP', `LOSS booked: ${shares.toFixed(1)} shares of outcome ${pos.outcomeIdx} worthless, winner ${winningIdx} — cost ${lostCost.toFixed(2)} TST — ${pos.marketProxy}`);
                        await notify(`❌ *LOSS* — market settled against us\n\`${pos.marketProxy}\`\n${shares.toFixed(1)} shares of outcome ${pos.outcomeIdx} expired worthless. Written off: ${lostCost.toFixed(2)} TST.`);
                        continue;
                    }
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
// ─── Exit Manager: stop-loss / free-roll / edge-exhausted ────────────────────
const EXIT_EDGE_THRESHOLD = 0.01; // Backstop: full exit when remaining net edge < 1%
const STOP_LOSS_PCT = 0.30; // Hard stop: cut any position down 30% from entry
const FREE_ROLL_GAIN_PCT = 0.20; // Winner up ≥20% vs entry → recover the cost, ride the rest
const FREE_ROLL_MAX_FRACTION = 0.70; // Never sell more than 70% of a position in the free-roll pass
const FREE_ROLL_MIN_COST = 1.0; // Don't bother free-rolling dust cost bases
const PROFIT_TARGET_PCT = 0.05; // Scalp rule: square off fully at +5% vs entry...
const PROFIT_TARGET_EDGE_CEIL = 0.03; // ...but only once the remaining edge is under 3% (don't cap big winners)
const SELL_SLIPPAGE_BPS = 200n;
/**
 * Leader-style exits on every open position, evaluated each loop:
 *  1. STOP-LOSS  — mark ≤ entry × (1 − 30%): sell everything unconditionally.
 *  2. EDGE GONE  — remaining net edge < 1%: sell everything regardless of PnL
 *     (converged winners and thesis reversals both land here).
 *  3. FREE-ROLL  — winner up ≥20% with edge still intact: sell just enough
 *     shares to recover the ENTIRE cost basis, then ride the remainder to
 *     settlement risk-free. This is the leader's signature move — in 4 of
 *     their 6 settled markets they pre-sold 23–88% of shares to cover cost
 *     and redeemed the residual as pure profit.
 *  A free-rolled position (net cost ≤ 0) can no longer stop-loss — there is
 *  nothing left to lose — and only exits fully when its edge dies.
 */
async function exitExhaustedPositions(markets) {
    let signer;
    try {
        signer = await delphiClient.getSigner();
    }
    catch {
        return;
    }
    let positions;
    try {
        ({ positions } = await delphiClient.listPositions({
            wallet: signer.address,
            redeemedOrLiquidated: false,
        }));
    }
    catch {
        return;
    }
    if (!positions || positions.length === 0)
        return;
    for (const pos of positions) {
        try {
            const market = markets.find(m => m.address.toLowerCase() === pos.marketProxy.toLowerCase());
            if (!market)
                continue; // not open — the settlement sweep handles it
            const idx = Number(pos.outcomeIdx);
            const sharesIn = BigInt(pos.shares);
            const sharesNum = Number(pos.shares) / 1e18;
            if (sharesNum < 0.01)
                continue;
            const price = market.spotPrices[idx];
            if (price === undefined)
                continue;
            const lastEval = await getLastEvaluation(market.address);
            const pOut = lastEval ? (idx === 0 ? lastEval.predicted_prob : 1 - lastEval.predicted_prob) : null;
            const remainingEdge = pOut !== null ? netEdge(pOut, price, market.tradingFee) : null;
            // Entry basis from the journal. Net of prior partial sells — a
            // free-rolled position shows netCost ≤ 0.
            const entry = await getOpenEntry(market.address, idx);
            const netCost = entry?.costTokens ?? null;
            const freeRolled = netCost !== null && netCost <= FREE_ROLL_MIN_COST * 0.5;
            const entryPrice = entry && entry.shares > 0 && !freeRolled ? entry.costTokens / entry.shares : null;
            const gainPct = entryPrice ? price / entryPrice - 1 : null;
            // FREE-ROLL: winner with edge intact → recover the cost basis,
            // keep the rest as a risk-free claim on settlement.
            if (!freeRolled && gainPct !== null && gainPct >= FREE_ROLL_GAIN_PCT
                && remainingEdge !== null && remainingEdge >= EXIT_EDGE_THRESHOLD
                && netCost !== null && netCost >= FREE_ROLL_MIN_COST) {
                const targetShares = Math.min(netCost / price, sharesNum * FREE_ROLL_MAX_FRACTION);
                let sellShares = sharesToBigint(targetShares);
                if (sellShares > sharesIn)
                    sellShares = sharesIn;
                const quote = await delphiClient.quoteSell({
                    marketAddress: market.address,
                    outcomeIdx: idx,
                    sharesIn: sellShares,
                });
                const proceeds = tokensFromBigint(quote.tokensOut);
                const sellEff = proceeds / sharesFromBigint(sellShares);
                if (sellEff < price * 0.9) {
                    console.log(`   ⏭️  Free-roll skipped for ${market.address}: sell slippage too deep.`);
                    continue;
                }
                console.log(`🎲 FREE-ROLL "${market.question.slice(0, 55)}": selling ${sharesFromBigint(sellShares).toFixed(2)}/${sharesNum.toFixed(2)} shares @ ~${sellEff.toFixed(3)} → ${proceeds.toFixed(2)} TST recovers cost ${netCost.toFixed(2)}. Rest rides free.`);
                let txHash = null;
                if (!DRY_RUN) {
                    const res = await delphiClient.sellShares({
                        marketAddress: market.address,
                        outcomeIdx: idx,
                        sharesIn: sellShares,
                        minTokensOut: quote.tokensOut * (10000n - SELL_SLIPPAGE_BPS) / 10000n,
                    });
                    txHash = res.transactionHash;
                }
                // Journal the sell leg as a negative trade row: net position and
                // net cost stay correct, and the market is NOT closed out.
                await recordTrade({
                    marketAddress: market.address,
                    question: market.question,
                    category: market.category,
                    outcomeIdx: idx,
                    outcomeLabel: market.outcomes[idx],
                    predictedProb: pOut ?? 0,
                    marketPrice: price,
                    effectivePrice: sellEff,
                    shares: -sharesFromBigint(sellShares),
                    costTokens: -proceeds,
                    dryRun: DRY_RUN,
                    txHash,
                });
                logEvent('SELL', `FREE-ROLL: recovered ${proceeds.toFixed(2)} TST (cost ${netCost.toFixed(2)}) selling ${sharesFromBigint(sellShares).toFixed(1)} of ${sharesNum.toFixed(1)} "${market.outcomes[idx]}" — remainder rides free — "${market.question.slice(0, 55)}"${DRY_RUN ? ' [DRY]' : ''}`);
                await notify(`🎲 *FREE-ROLL* on _${market.question.slice(0, 80)}_\nSold ${sharesFromBigint(sellShares).toFixed(1)} of ${sharesNum.toFixed(1)} shares for *${proceeds.toFixed(2)} TST* — full cost recovered. Remaining ${(sharesNum - sharesFromBigint(sellShares)).toFixed(1)} shares are pure upside.`);
                continue;
            }
            let reason = null;
            if (gainPct !== null && gainPct <= -STOP_LOSS_PCT) {
                reason = `STOP-LOSS (${(gainPct * 100).toFixed(1)}% vs entry ${entryPrice.toFixed(3)})`;
            }
            else if (remainingEdge !== null && remainingEdge < EXIT_EDGE_THRESHOLD) {
                reason = `edge exhausted (${(remainingEdge * 100).toFixed(1)}%)${freeRolled ? ' — free-roll ride ends' : ''}`;
            }
            else if (gainPct !== null && gainPct >= PROFIT_TARGET_PCT
                && remainingEdge !== null && remainingEdge < PROFIT_TARGET_EDGE_CEIL) {
                // Scalp square-off: the move we predicted has mostly happened —
                // book the profit and put the capital back to work.
                reason = `PROFIT TARGET (+${(gainPct * 100).toFixed(1)}% vs entry ${entryPrice.toFixed(3)}, residual edge ${(remainingEdge * 100).toFixed(1)}%)`;
            }
            if (!reason)
                continue; // keep holding
            // Quote the exit and sanity-check sell-side slippage.
            const { tokensOut } = await delphiClient.quoteSell({
                marketAddress: market.address,
                outcomeIdx: idx,
                sharesIn,
            });
            const proceeds = tokensFromBigint(tokensOut);
            const sellEffPrice = proceeds / sharesNum;
            if (sellEffPrice < price * 0.9) {
                console.log(`   ⏭️  Exit skipped for ${market.address}: sell-side slippage too deep (${sellEffPrice.toFixed(3)} vs spot ${price.toFixed(3)}).`);
                continue;
            }
            const minTokensOut = tokensOut * (10000n - SELL_SLIPPAGE_BPS) / 10000n;
            console.log(`💸 Exiting "${market.question.slice(0, 60)}" — ${sharesNum.toFixed(2)} × "${market.outcomes[idx]}" @ ~${sellEffPrice.toFixed(3)} (${proceeds.toFixed(2)} TST). Reason: ${reason}.`);
            if (!DRY_RUN) {
                await delphiClient.sellShares({
                    marketAddress: market.address,
                    outcomeIdx: idx,
                    sharesIn,
                    minTokensOut,
                });
            }
            await recordSettlement(pos.marketProxy, 'sell', proceeds);
            logEvent('SELL', `${sharesNum.toFixed(2)} "${market.outcomes[idx]}" @ ${sellEffPrice.toFixed(3)} → +${proceeds.toFixed(2)} TST — ${reason} — "${market.question.slice(0, 60)}"${DRY_RUN ? ' [DRY]' : ''}`);
            await notify(`💸 *SOLD* ${sharesNum.toFixed(1)} × "${market.outcomes[idx]}" for *${proceeds.toFixed(2)} TST*\n_${market.question.slice(0, 90)}_\n${reason} — capital freed for redeployment.`);
        }
        catch (e) {
            console.error(`  Exit check failed for ${pos.marketProxy}:`, e.message?.slice(0, 150));
        }
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
/**
 * EV ranking score (report §3): base = net edge, boosted for
 *  ×1.5 deterministic facts (event already concluded — near-zero variance),
 *  ×1.2 thin markets (uncontested mispricings persist),
 *  ×1.15 crowd piling onto the side we fade (their flow cheapened our side).
 */
function scoreCandidate(c) {
    let s = c.provisionalEdge;
    if (c.prediction.eventConcluded)
        s *= 1.5;
    if (c.flowTrades24h < 20)
        s *= 1.2;
    if (c.crowdBoost)
        s *= 1.15;
    if (c.momentumBoost)
        s *= 1.05; // sentiment blowing our way
    // The leader's whole book lives at 0.35–0.80: where information edges are
    // largest and payoffs aren't lottery-shaped. Prefer that band.
    if (c.spotPrice >= 0.35 && c.spotPrice <= 0.80)
        s *= 1.1;
    // …and prefer riding the market's favored side (43 of the leader's 69
    // buys are the favorite at 0.50–0.75) over fighting the crowd.
    if (c.spotPrice >= 0.50)
        s *= 1.08;
    return s;
}
/** Crowd-against-us: rivals bought the opposite outcome ≥3× harder than ours. */
function computeCrowdBoost(outcomeIdx, buyVol0, buyVol1) {
    const ours = outcomeIdx === 0 ? buyVol0 : buyVol1;
    const theirs = outcomeIdx === 0 ? buyVol1 : buyVol0;
    return theirs > 20 && theirs > ours * 3;
}
/** Crowd-with-us: rivals are piling onto OUR side — sentiment confirmation. */
function computeMomentumBoost(outcomeIdx, buyVol0, buyVol1) {
    const ours = outcomeIdx === 0 ? buyVol0 : buyVol1;
    const theirs = outcomeIdx === 0 ? buyVol1 : buyVol0;
    return ours > 20 && ours > theirs * 3;
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
async function candidateFromStoredEval(market, predictedProb) {
    const currentImpliedProb = market.impliedProbabilities[0];
    const grossEdge = predictedProb - currentImpliedProb;
    const outcomeIdx = grossEdge > 0 ? 0 : 1;
    const effectiveProb = outcomeIdx === 0 ? predictedProb : 1 - predictedProb;
    const spotPrice = market.spotPrices[outcomeIdx] ?? (outcomeIdx === 0 ? currentImpliedProb : 1 - currentImpliedProb);
    const provisionalEdge = netEdge(effectiveProb, spotPrice, market.tradingFee);
    if (provisionalEdge < DEFAULT_GUARDRAILS.minEdgeThreshold)
        return null;
    const flow = await getMarketFlow(market.address);
    return {
        market,
        prediction: {
            probability: predictedProb,
            rawProb: predictedProb,
            geminiProb: predictedProb,
            pythonProb: null,
            reasoning: 'Cached recent evaluation, re-priced at current market price.',
            eventConcluded: false,
            ambiguity: 'none',
            weightOnMarket: 0,
            consensusNote: 'cached',
        },
        outcomeIdx, effectiveProb, spotPrice, provisionalEdge,
        flowTrades24h: flow.trades24h,
        crowdBoost: computeCrowdBoost(outcomeIdx, flow.buyVolOutcome0, flow.buyVolOutcome1),
        momentumBoost: computeMomentumBoost(outcomeIdx, flow.buyVolOutcome0, flow.buyVolOutcome1),
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
                const cached = await candidateFromStoredEval(market, lastEval.predicted_prob);
                if (cached) {
                    console.log(`📎 Cached candidate: "${market.question}" — net edge ${(cached.provisionalEdge * 100).toFixed(2)}% (evaluated ${((Date.now() - lastEval.evaluated_at) / 60000).toFixed(0)}m ago)`);
                    candidates.push(cached);
                }
            }
            continue;
        }
        const budget = pacedGeminiBudget();
        if (dailyGeminiCallCount >= budget) {
            console.warn(`⚠️  Paced Gemini budget reached (${dailyGeminiCallCount}/${budget} released of ${MAX_DAILY_GEMINI_CALLS}/day). Deferring remaining evaluations.`);
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
        const prediction = await getCombinedProbability(market, articles, true, {
            summary: flow.summary,
            trades24h: flow.trades24h,
            uniqueWallets24h: flow.uniqueWallets24h,
        });
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
        await saveEvaluation(market.address, prediction.probability, currentImpliedProb, prediction.rawProb, market.category);
        const grossEdge = prediction.probability - currentImpliedProb;
        const outcomeIdx = grossEdge > 0 ? 0 : 1;
        const effectiveProb = outcomeIdx === 0 ? prediction.probability : 1 - prediction.probability;
        const spotPrice = market.spotPrices[outcomeIdx] ?? (outcomeIdx === 0 ? currentImpliedProb : 1 - currentImpliedProb);
        const provisionalEdge = netEdge(effectiveProb, spotPrice, market.tradingFee);
        console.log(`   🧠 P("${market.outcomes[0]}") = ${(prediction.probability * 100).toFixed(2)}% (raw ${(prediction.rawProb * 100).toFixed(1)}%, market ${(currentImpliedProb * 100).toFixed(2)}%)${prediction.eventConcluded ? ' [VERIFIED FACT]' : ''}${prediction.ambiguity !== 'none' ? ` [ambiguity: ${prediction.ambiguity}]` : ''}`);
        console.log(`   ⚡ Best side: "${market.outcomes[outcomeIdx]}" | provisional net edge: ${(provisionalEdge * 100).toFixed(2)}%`);
        console.log(`   💬 ${prediction.reasoning}`);
        logEvent('THINK', `"${market.question.slice(0, 70)}" → P=${(prediction.probability * 100).toFixed(1)}% vs mkt ${(currentImpliedProb * 100).toFixed(1)}% | edge ${(provisionalEdge * 100).toFixed(1)}% on "${market.outcomes[outcomeIdx]}" — ${prediction.reasoning.slice(0, 140)}`);
        if (provisionalEdge >= guardrails.minEdgeThreshold) {
            candidates.push({
                market, prediction, outcomeIdx, effectiveProb, spotPrice, provisionalEdge,
                flowTrades24h: flow.trades24h,
                crowdBoost: computeCrowdBoost(outcomeIdx, flow.buyVolOutcome0, flow.buyVolOutcome1),
                momentumBoost: computeMomentumBoost(outcomeIdx, flow.buyVolOutcome0, flow.buyVolOutcome1),
            });
        }
        else if (provisionalEdge > 0) {
            logEvent('SKIP', `"${market.question.slice(0, 60)}": edge ${(provisionalEdge * 100).toFixed(1)}% below ${(guardrails.minEdgeThreshold * 100).toFixed(0)}% threshold`);
        }
        await delay(INTER_EVAL_DELAY_MS);
    }
    return candidates;
}
// ─── Execution Phase ─────────────────────────────────────────────────────────
const MAX_ENTRY_PRICE = 0.92; // DON'T chase: never buy above 0.92 unless the fact is verified
const MIN_ENTRY_PRICE = 0.15; // DON'T buy longshots below 0.15 unless the fact is verified
const VERIFIED_FACT_BET_PCT = 0.15; // Deterministic-fact trades earn a larger cap (still hard-capped)
const MIN_TRADE_PROFIT_TST = 0.5; // DON'T churn: skip trades whose expected profit can't clear fees meaningfully
async function executeCandidate(c, bankroll, guardrails) {
    const { market, outcomeIdx } = c;
    const label = market.outcomes[outcomeIdx];
    // Verified facts (event concluded, ≥95% conviction) justify pushing the
    // price further toward belief — larger cap, every other check unchanged.
    const isVerifiedFact = c.prediction.eventConcluded && c.effectiveProb >= 0.95;
    if (isVerifiedFact) {
        guardrails = { ...guardrails, maxSingleBetPct: Math.max(guardrails.maxSingleBetPct, VERIFIED_FACT_BET_PCT) };
    }
    // Correlation guard: cap open exposure per category.
    const exposure = await openCostByCategory();
    if ((exposure[market.category] || 0) >= bankroll * MAX_CATEGORY_EXPOSURE_PCT) {
        console.log(`   ⏭️  Category "${market.category}" already at max exposure (${(exposure[market.category] || 0).toFixed(1)} TST). Skipping.`);
        logEvent('SKIP', `"${market.question.slice(0, 60)}": ${market.category} exposure cap reached`);
        return 0;
    }
    // Scale-in guard: adds to an existing position are allowed (the leader
    // scales into conviction), but one market never exceeds 20% of bankroll.
    const existing = await getOpenEntry(market.address, outcomeIdx);
    if (existing && existing.costTokens >= bankroll * MAX_MARKET_EXPOSURE_PCT) {
        console.log(`   ⏭️  Market already at max exposure (${existing.costTokens.toFixed(1)} TST). Skipping scale-in.`);
        logEvent('SKIP', `"${market.question.slice(0, 60)}": per-market exposure cap reached`);
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
    // DON'T chase near-certain prices without verification: buying at 0.95
    // risks 19:1 downside on any settlement surprise.
    if (effectivePrice > MAX_ENTRY_PRICE && !isVerifiedFact) {
        console.log(`   ⏭️  Entry price ${effectivePrice.toFixed(3)} > ${MAX_ENTRY_PRICE} without verified fact. Skipping (asymmetric downside).`);
        logEvent('SKIP', `"${market.question.slice(0, 60)}": price ${effectivePrice.toFixed(2)} too high without verification`);
        return 0;
    }
    // DON'T buy lottery tickets: below 0.15 the "edge" is usually our model
    // overriding the crowd on a longshot (the Astra failure mode). The leader
    // has zero entries under 0.10. Verified facts are exempt.
    if (effectivePrice < MIN_ENTRY_PRICE && !isVerifiedFact) {
        console.log(`   ⏭️  Entry price ${effectivePrice.toFixed(3)} < ${MIN_ENTRY_PRICE} without verified fact. Skipping (longshot filter).`);
        logEvent('SKIP', `"${market.question.slice(0, 60)}": longshot at ${effectivePrice.toFixed(2)} without verification`);
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
    let maxTokensIn = tokensIn * (10000n + MAX_SLIPPAGE_BPS) / 10000n;
    let costHuman = tokensFromBigint(tokensIn);
    let maxCostHuman = tokensFromBigint(maxTokensIn);
    // If the quote lands slightly OVER the hard cap, trim the order to fit
    // instead of abandoning the trade — a 2% size haircut beats a 100% one.
    const capSpend = bankroll * guardrails.maxSingleBetPct * (1 + Number(MAX_SLIPPAGE_BPS) / 10_000);
    if (maxCostHuman > capSpend && maxCostHuman <= capSpend * 1.15) {
        const scale = (capSpend / maxCostHuman) * 0.99;
        sharesOut = sharesOut * BigInt(Math.round(scale * 1e6)) / 1000000n;
        const requote = await getSlippageQuote(market.address, outcomeIdx, sharesOut);
        if (!requote)
            return 0;
        tokensIn = requote;
        effectivePrice = tokensFromBigint(tokensIn) / sharesFromBigint(sharesOut);
        maxTokensIn = tokensIn * (10000n + MAX_SLIPPAGE_BPS) / 10000n;
        costHuman = tokensFromBigint(tokensIn);
        maxCostHuman = tokensFromBigint(maxTokensIn);
    }
    // DON'T churn: expected profit must clear the fee hurdle by a real margin.
    const expectedProfit = edgeAfterSlippage * sharesFromBigint(sharesOut);
    if (expectedProfit < MIN_TRADE_PROFIT_TST) {
        console.log(`   ⏭️  Expected profit ${expectedProfit.toFixed(3)} TST below ${MIN_TRADE_PROFIT_TST} floor — dust trade, fees would dominate. Skipping.`);
        logEvent('SKIP', `"${market.question.slice(0, 60)}": expected profit ${expectedProfit.toFixed(2)} TST too small`);
        return 0;
    }
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
    // 0b. Self-calibration: refit consensus weights from settled outcomes
    //     every ~6h (cheap; no-ops until enough markets have settled).
    const lastCal = Number(await getState('lastCalibrationTs')) || 0;
    if (Date.now() - lastCal > 6 * 3600_000) {
        await selfCalibrate();
        await setState('lastCalibrationTs', String(Date.now()));
    }
    // 1. Sweep first — frees settled capital before sizing new trades, and
    //    keeps the realized-PnL journal current for the circuit breaker.
    await sweepSettledPositions();
    // 1b. Scan open markets (earliest-settling first), then exit any position
    //     whose edge is exhausted — freed capital is reflected in the bankroll
    //     fetched right after.
    const markets = await scanOpenMarkets();
    lastMarkets = markets;
    // Price-history recorder: one snapshot per market per loop. This is the
    // dataset future models (volatility, drift labels, longshot-bias curve)
    // train on — collected whether or not we trade.
    try {
        await recordPriceSnapshots(markets.map(m => ({
            market: m.address,
            p0: m.impliedProbabilities[0],
            p1: m.impliedProbabilities[1] ?? null,
        })));
    }
    catch (e) {
        console.warn('  Price snapshot failed:', e.message?.slice(0, 100));
    }
    await exitExhaustedPositions(markets);
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
    // 4. Refresh the market-situation picture
    const newTrades = await pollAllTrades();
    const posture = await getCompetitionPosture(markets);
    lastPosture = posture;
    const perf = await performanceStats();
    activeGuardrails = postureAdjustedGuardrails(posture, bankroll, perf);
    console.log(`📊 Found ${markets.length} open binary markets with live price data.`);
    console.log(`🌐 Situation: +${newTrades} new competitor trades indexed | ${posture.summary}`);
    console.log(`🎚️  Risk posture: Kelly ${activeGuardrails.fractionalKelly} | max bet ${(activeGuardrails.maxSingleBetPct * 100).toFixed(0)}% | closed ${perf.settled} (win rate ${(perf.winRate * 100).toFixed(0)}%, net ${perf.netPnl.toFixed(1)})`);
    console.log(`🔒 Daily Usage: Trades [${dailyTradeCount}/${MAX_DAILY_TRADES}] | Gemini [${dailyGeminiCallCount}/${MAX_DAILY_GEMINI_CALLS}]`);
    // 5. Evaluate → rank by net edge → execute the BEST candidates, not the
    //    first encountered ("act on your edges without cherry-picking").
    const candidates = await evaluateMarkets(markets, activeGuardrails);
    candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
    console.log(`\n🏁 ${candidates.length} candidate(s) clear the net-edge threshold.`);
    for (const c of candidates.slice(0, 5)) {
        const tags = [
            c.prediction.eventConcluded ? 'FACT×1.5' : null,
            c.flowTrades24h < 20 ? 'THIN×1.2' : null,
            c.crowdBoost ? 'FADE×1.15' : null,
        ].filter(Boolean).join(' ');
        console.log(`   ${(scoreCandidate(c) * 100).toFixed(1)} pts | edge ${(c.provisionalEdge * 100).toFixed(1)}% ${tags ? '| ' + tags : ''} | "${c.market.question.slice(0, 55)}"`);
    }
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
    const snap = await performanceSnapshot();
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`✅ Loop finished. Trades: ${loopTradesExecuted}/${MAX_TRADES_PER_LOOP} this loop, ${dailyTradeCount}/${MAX_DAILY_TRADES} today.`);
    console.log(`📒 Journal: ${snap.totalTrades} live trades, ${snap.settled} settled, net PnL ${snap.netPnl.toFixed(4)} tokens.`);
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
        const out = [];
        for (const pos of positions) {
            const idx = Number(pos.outcomeIdx);
            const shares = Number(pos.shares) / 1e18;
            // Open markets come from the scan cache; positions whose market has
            // CLOSED for trading (awaiting_settlement/settled) are not in the
            // scan, so fetch them directly — otherwise they'd show as mark 0.
            let m = lastMarkets.find(mk => mk.address.toLowerCase() === pos.marketProxy.toLowerCase());
            let question = m?.question;
            let outcomes = m?.outcomes;
            let price = m?.spotPrices[idx];
            let status = m ? 'open' : pos.marketStatus;
            if (!m) {
                try {
                    const full = await delphiClient.getMarket({
                        id: pos.marketProxy,
                        pricesAndImpliedProbabilities: true,
                    });
                    question = full.metadata?.question ?? question;
                    outcomes = full.metadata?.outcomes ?? outcomes;
                    status = full.status;
                    if (full.status === 'settled' && full.winningOutcomeIdx !== null) {
                        // Settled: a share is worth exactly 1 if it won, 0 if it lost.
                        price = Number(full.winningOutcomeIdx) === idx ? 1 : 0;
                    }
                    else {
                        price = full.spotPrices?.[idx];
                    }
                }
                catch { /* market unreachable — leave fallbacks */ }
            }
            out.push({
                market: pos.marketProxy,
                question: question || pos.marketProxy,
                outcome: outcomes?.[idx] || `outcome ${idx}`,
                shares,
                mark: price !== undefined ? shares * price : 0,
                status,
            });
        }
        return out;
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
    const statusTag = (s) => s === 'open' ? '' :
        s === 'awaiting_settlement' ? ' ⏳ awaiting settlement' :
            s === 'settled' ? ' 🏁 settled' : ` (${s})`;
    return `📊 Holdings (mark ${total.toFixed(2)} TST)\n\n` +
        h.map(p => `• ${p.shares.toFixed(1)} × "${p.outcome}" ≈ ${p.mark.toFixed(2)} TST${statusTag(p.status)}\n  ${p.question.slice(0, 70)}`).join('\n');
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
