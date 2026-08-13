import * as dotenv from 'dotenv';
dotenv.config();
import { initDatabase } from './ingestion/keywordFilter';
import { scanOpenMarkets } from './execution/marketScanner';
import { scrapeNews } from './ingestion/rssScraper';
import { getCombinedProbability } from './intelligence';
import { calculatePositionSize, DEFAULT_GUARDRAILS } from './risk/kellyCalculator';
import { getSlippageQuote } from './execution/quoteEngine';
import { executeTrade } from './execution/tradeExecutor';
import { delphiClient } from './execution/delphiClient';
import { LIQUIDATABLE_MARKET_STATUSES } from '@gensyn-ai/gensyn-delphi-sdk';
// ─── Operational & Rate Constraints ──────────────────────────────────────────
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes polling interval
const INTER_MARKET_DELAY_MS = 2000; // 2 seconds pause between markets
const MAX_TRADES_PER_LOOP = 2; // Max 2 trades per 5-minute loop (anti-overtrading)
const MAX_DAILY_TRADES = 20; // Max 20 trades per 24 hours
const MAX_DAILY_GEMINI_CALLS = 200; // Max 200 Gemini API calls per 24 hours
const MAX_SLIPPAGE_BPS = 200; // 2% max slippage (200 basis points)
const TOKEN_DECIMALS = 6; // Competition token (TST/USDC) uses 6 decimals
const SHARE_DECIMALS = 18; // Shares use 18 decimals
const DRY_RUN = process.env.DRY_RUN === 'true'; // DRY_RUN flag from .env
// ─── Rate & Budget Trackers ───────────────────────────────────────────────────
let dailyTradeCount = 0;
let dailyGeminiCallCount = 0;
let lastResetTimestamp = Date.now();
function checkAndResetDailyQuotas() {
    const now = Date.now();
    const elapsedHours = (now - lastResetTimestamp) / (1000 * 60 * 60);
    if (elapsedHours >= 24) {
        console.log(`\n🕒 24 hours elapsed. Resetting daily counters (Previous trades: ${dailyTradeCount}, Gemini calls: ${dailyGeminiCallCount}).`);
        dailyTradeCount = 0;
        dailyGeminiCallCount = 0;
        lastResetTimestamp = now;
    }
}
// ─── Keyword Extraction ──────────────────────────────────────────────────────
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
// ─── Sweep Settled Positions ─────────────────────────────────────────────────
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
                    console.log(`  ✅ Redeemed! Tokens received: ${tokensOut}`);
                }
                else if (LIQUIDATABLE_MARKET_STATUSES.includes(status)) {
                    console.log(`  Liquidating ${status} market ${pos.marketProxy}...`);
                    const { totalTokensOut } = await delphiClient.liquidate({
                        marketAddress: pos.marketProxy,
                        outcomeIndices: [0, 1],
                    });
                    console.log(`  ✅ Liquidated! Tokens received: ${totalTokensOut}`);
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
// ─── Main Polling Loop ────────────────────────────────────────────────────────
async function runLoop() {
    const timestamp = new Date().toISOString();
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`🔄 Trading Loop Started — ${timestamp}`);
    console.log(`${'═'.repeat(70)}`);
    // ── 0. Check Daily Quotas ───────────────────────────────────────────
    checkAndResetDailyQuotas();
    if (dailyTradeCount >= MAX_DAILY_TRADES) {
        console.warn(`🛑 Daily trade limit reached (${dailyTradeCount}/${MAX_DAILY_TRADES}). Skipping this loop.`);
        return;
    }
    // ── 1. Fetch & Check Bankroll (Bankruptcy & Debt Protection) ────────
    let bankroll = 0;
    try {
        const balanceRaw = await delphiClient.getErc20Balance();
        bankroll = Number(balanceRaw) / Math.pow(10, TOKEN_DECIMALS);
        console.log(`💰 Available Bankroll: ${bankroll.toFixed(4)} tokens`);
    }
    catch (e) {
        console.error("❌ Could not fetch bankroll from network. Aborting loop.");
        return;
    }
    if (bankroll < DEFAULT_GUARDRAILS.minBankrollThreshold) {
        if (DRY_RUN) {
            console.log(`ℹ️  Bankroll (${bankroll.toFixed(2)}) is below safety threshold (${DEFAULT_GUARDRAILS.minBankrollThreshold}). Using 100.0 test tokens for DRY RUN evaluation.`);
            bankroll = 100.0;
        }
        else {
            console.warn(`🛑 Bankroll (${bankroll.toFixed(2)}) is below minimum safety threshold (${DEFAULT_GUARDRAILS.minBankrollThreshold} tokens). Trading halted to prevent bankruptcy.`);
            return;
        }
    }
    // ── 2. Scan Open Markets ─────────────────────────────────────────────
    const markets = await scanOpenMarkets();
    console.log(`📊 Found ${markets.length} open markets with live price data.`);
    console.log(`🔒 Daily Usage: Trades [${dailyTradeCount}/${MAX_DAILY_TRADES}] | Gemini Calls [${dailyGeminiCallCount}/${MAX_DAILY_GEMINI_CALLS}]\n`);
    let loopTradesExecuted = 0;
    for (const market of markets) {
        // Enforce max trades per loop constraint
        if (loopTradesExecuted >= MAX_TRADES_PER_LOOP) {
            console.log(`🛑 Reached max trades per loop limit (${MAX_TRADES_PER_LOOP}). Stopping loop evaluation.`);
            break;
        }
        // Enforce daily trade limit constraint
        if (dailyTradeCount >= MAX_DAILY_TRADES) {
            console.log(`🛑 Daily trade limit reached (${MAX_DAILY_TRADES}). Stopping execution.`);
            break;
        }
        console.log(`${'─'.repeat(60)}`);
        console.log(`📋 Market: "${market.question}"`);
        console.log(`   Address: ${market.address}`);
        console.log(`   Category: ${market.category} | Settles: ${market.settlesAt || 'Unknown'}`);
        console.log(`   Implied Probabilities: ${market.impliedProbabilities.map((p) => (p * 100).toFixed(1) + '%').join(' / ')}`);
        const currentImpliedProb = market.impliedProbabilities[0];
        // ── Ingestion: Search for new articles ──────────────────────────
        const keyword = extractKeywords(market.question);
        console.log(`   🔍 Searching news for: "${keyword}"`);
        const articles = await scrapeNews(keyword);
        console.log(`   📰 Found ${articles.length} new articles.`);
        if (articles.length === 0) {
            console.log(`   ⏭️  No new information. Skipping.`);
            await new Promise(r => setTimeout(r, INTER_MARKET_DELAY_MS));
            continue;
        }
        // Check Gemini daily API budget before calling
        if (dailyGeminiCallCount >= MAX_DAILY_GEMINI_CALLS) {
            console.warn(`   ⚠️ Daily Gemini API call limit reached (${MAX_DAILY_GEMINI_CALLS}). Using market price fallback.`);
        }
        else {
            dailyGeminiCallCount++;
        }
        // ── Intelligence Engine ─────────────────────────────────────────
        const prediction = await getCombinedProbability(market.address, market.question, articles, currentImpliedProb);
        const edge = prediction.probability - currentImpliedProb;
        console.log(`   🧠 Combined Probability: ${(prediction.probability * 100).toFixed(2)}%`);
        console.log(`   📈 Market Price:        ${(currentImpliedProb * 100).toFixed(2)}%`);
        console.log(`   ⚡ Edge:                ${(edge * 100).toFixed(2)}%`);
        console.log(`   💬 Reasoning: ${prediction.reasoning}`);
        // Determine direction (YES vs NO)
        const outcomeIdx = edge > 0 ? 0 : 1;
        const effectiveProb = edge > 0 ? prediction.probability : (1 - prediction.probability);
        const effectiveMarketPrice = edge > 0 ? currentImpliedProb : (1 - currentImpliedProb);
        // ── Risk Management & Bankruptcy Protection ─────────────────────
        const betSize = calculatePositionSize(effectiveProb, effectiveMarketPrice, bankroll, DEFAULT_GUARDRAILS);
        console.log(`   🎯 Guardrailed Bet Size: ${betSize.toFixed(4)} tokens (Outcome ${outcomeIdx}: ${market.outcomes[outcomeIdx]})`);
        if (betSize <= 0) {
            console.log(`   ⏭️  Risk guardrails evaluated no trade. Skipping.`);
            await new Promise(r => setTimeout(r, INTER_MARKET_DELAY_MS));
            continue;
        }
        // ── Execution Engine ────────────────────────────────────────────
        const sharesOut = BigInt(Math.round(betSize * Math.pow(10, SHARE_DECIMALS)));
        const expectedTokensIn = await getSlippageQuote(market.address, outcomeIdx, sharesOut);
        if (!expectedTokensIn) {
            console.warn(`   ❌ Quote failed. Skipping trade.`);
            await new Promise(r => setTimeout(r, INTER_MARKET_DELAY_MS));
            continue;
        }
        const slippageBps = BigInt(MAX_SLIPPAGE_BPS);
        const maxTokensIn = expectedTokensIn * (10000n + slippageBps) / 10000n;
        const costHuman = (Number(expectedTokensIn) / 1e6).toFixed(6);
        const maxCostHuman = (Number(maxTokensIn) / 1e6).toFixed(6);
        console.log(`   💵 Quoted Cost: ${costHuman} TST (Max with slippage: ${maxCostHuman} TST)`);
        // Hard Safety Cap: Single trade cost must not exceed maxSingleBetPct (5%) of bankroll
        const maxAllowedSpend = bankroll * DEFAULT_GUARDRAILS.maxSingleBetPct;
        if (Number(maxTokensIn) / 1e6 > maxAllowedSpend) {
            console.warn(`   ❌ Quoted cost (${maxCostHuman} TST) exceeds max allowed spend (${maxAllowedSpend.toFixed(2)} TST). Skipping.`);
            await new Promise(r => setTimeout(r, INTER_MARKET_DELAY_MS));
            continue;
        }
        if (DRY_RUN) {
            console.log(`   🏜️  DRY RUN — Would buy ${(Number(sharesOut) / 1e18).toFixed(4)} shares of outcome ${outcomeIdx} (${market.outcomes[outcomeIdx]}) for ~${costHuman} TST.`);
            loopTradesExecuted++;
            dailyTradeCount++;
        }
        else {
            console.log(`   🚀 Executing live trade...`);
            const txHash = await executeTrade(market.address, outcomeIdx, sharesOut, maxTokensIn);
            if (txHash) {
                loopTradesExecuted++;
                dailyTradeCount++;
            }
        }
        // Pacing delay between market calls to respect API & network limits
        await new Promise(r => setTimeout(r, INTER_MARKET_DELAY_MS));
    }
    // ── Sweep Settled Positions ─────────────────────────────────────────
    await sweepSettledPositions();
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`✅ Loop finished. Trades executed this loop: ${loopTradesExecuted}/${MAX_TRADES_PER_LOOP} | Daily Trades: ${dailyTradeCount}/${MAX_DAILY_TRADES}`);
    console.log(`⏳ Next polling loop in ${POLL_INTERVAL_MS / 1000}s...`);
    console.log(`${'═'.repeat(70)}\n`);
}
// ─── Entry Point ─────────────────────────────────────────────────────────────
async function main() {
    console.log(`
    ╔═════════════════════════════════════════════════════════╗
    ║   DELPHI AUTONOMOUS TRADING AGENT                       ║
    ║   Gensyn Agent Arena — Competition                      ║
    ║   Protected by Strict Financial & Rate Guardrails       ║
    ╚═════════════════════════════════════════════════════════╝
    `);
    if (DRY_RUN) {
        console.log("⚠️  DRY RUN MODE ENABLED — No real trades will be executed.\n");
    }
    await initDatabase();
    console.log("✅ SQLite database initialized.");
    // Run immediately
    await runLoop();
    // Polling interval
    setInterval(runLoop, POLL_INTERVAL_MS);
}
main().catch(console.error);
