import * as dotenv from 'dotenv';
dotenv.config();

import { initDatabase } from './ingestion/keywordFilter';
import { scanOpenMarkets, EnrichedMarket } from './execution/marketScanner';
import { scrapeNews } from './ingestion/rssScraper';
import { getCombinedProbability } from './intelligence';
import { calculatePositionSize } from './risk/kellyCalculator';
import { getSlippageQuote } from './execution/quoteEngine';
import { executeTrade } from './execution/tradeExecutor';
import { delphiClient } from './execution/delphiClient';
import { LIQUIDATABLE_MARKET_STATUSES } from '@gensyn-ai/gensyn-delphi-sdk';

// ─── Configuration ───────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FRACTIONAL_KELLY = 0.25;           // Quarter Kelly — conservative
const MIN_EDGE_THRESHOLD = 0.03;         // Don't trade unless edge > 3%
const MAX_SLIPPAGE_BPS = 200;            // 2% max slippage (200 basis points)
const TOKEN_DECIMALS = 6;               // Competition token (TST/USDC) uses 6 decimals
const SHARE_DECIMALS = 18;              // Shares always use 18 decimals
const DRY_RUN = process.env.DRY_RUN === 'true'; // Set DRY_RUN=true in .env to disable real trades

// ─── Extract Search Keywords from Market Question ────────────────────────────
function extractKeywords(question: string): string {
    // Remove common prediction market phrasing to get searchable terms
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

    // Take the most meaningful words (max 6) for a focused RSS search
    return words.slice(0, 6).join(' ');
}

// ─── Sweep: Redeem Settled Markets ───────────────────────────────────────────
async function sweepSettledPositions() {
    try {
        const signer = await delphiClient.getSigner();
        const { positions } = await delphiClient.listPositions({
            wallet: signer.address,
            redeemedOrLiquidated: false,
        });

        if (!positions || positions.length === 0) return;

        console.log(`\n🧹 Found ${positions.length} unredeemed positions. Sweeping...`);

        for (const pos of positions) {
            try {
                const status = await delphiClient.getMarketStatus(pos.marketProxy as `0x${string}`);

                if (status === 'settled') {
                    console.log(`  Redeeming settled market ${pos.marketProxy}...`);
                    const { tokensOut } = await delphiClient.redeemMarket({
                        marketAddress: pos.marketProxy as `0x${string}`,
                    });
                    console.log(`  ✅ Redeemed! Tokens received: ${tokensOut}`);
                } else if (LIQUIDATABLE_MARKET_STATUSES.includes(status)) {
                    console.log(`  Liquidating ${status} market ${pos.marketProxy}...`);
                    const { totalTokensOut } = await delphiClient.liquidate({
                        marketAddress: pos.marketProxy as `0x${string}`,
                        outcomeIndices: [0, 1],
                    });
                    console.log(`  ✅ Liquidated! Tokens received: ${totalTokensOut}`);
                }
            } catch (e) {
                console.error(`  Failed to process position ${pos.marketProxy}:`, e);
            }
        }
    } catch (e) {
        console.error("Sweep failed:", e);
    }
}

// ─── Main Trading Loop ──────────────────────────────────────────────────────
async function runLoop() {
    const timestamp = new Date().toISOString();
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`🔄 Trading Loop Started — ${timestamp}`);
    console.log(`${'═'.repeat(70)}`);

    // ── Fetch bankroll ──────────────────────────────────────────────────
    let bankroll = 0;
    try {
        const balanceRaw = await delphiClient.getErc20Balance();
        bankroll = Number(balanceRaw) / Math.pow(10, TOKEN_DECIMALS);
        console.log(`💰 Bankroll: ${bankroll.toFixed(4)} tokens`);
    } catch (e) {
        console.error("❌ Could not fetch bankroll. Aborting loop.");
        return;
    }

    if (bankroll <= 0) {
        if (DRY_RUN) {
            console.log("ℹ️  Bankroll is 0. Using test bankroll of 100.0 tokens for DRY RUN evaluation.");
            bankroll = 100.0;
        } else {
            console.warn("⚠️  Bankroll is 0. Nothing to trade with.");
            return;
        }
    }

    // ── Scan open markets with real on-chain prices ─────────────────────
    const markets = await scanOpenMarkets();
    console.log(`📊 Found ${markets.length} open markets with price data.\n`);

    let tradesAttempted = 0;
    let tradesExecuted = 0;

    for (const market of markets) {
        console.log(`${'─'.repeat(60)}`);
        console.log(`📋 Market: "${market.question}"`);
        console.log(`   Address: ${market.address}`);
        console.log(`   Category: ${market.category} | Settles: ${market.settlesAt || 'Unknown'}`);
        console.log(`   Outcomes: ${market.outcomes.join(' / ')}`);
        console.log(`   Implied Probabilities: ${market.impliedProbabilities.map(p => (p * 100).toFixed(1) + '%').join(' / ')}`);

        // We trade on outcome 0 (typically YES). The implied prob is index 0.
        const currentImpliedProb = market.impliedProbabilities[0]!;

        // ── 1. Ingestion: Scrape relevant news ──────────────────────────
        const keyword = extractKeywords(market.question);
        console.log(`   🔍 Searching news for: "${keyword}"`);
        const articles = await scrapeNews(keyword);
        console.log(`   📰 Found ${articles.length} new articles.`);

        if (articles.length === 0) {
            console.log(`   ⏭️  No new information. Skipping.`);
            continue;
        }

        // ── 2. Intelligence: Get combined probability ───────────────────
        const prediction = await getCombinedProbability(
            market.address,
            market.question,
            articles,
            currentImpliedProb
        );

        const edge = prediction.probability - currentImpliedProb;

        console.log(`   🧠 Our Probability: ${(prediction.probability * 100).toFixed(2)}%`);
        console.log(`   📈 Market Price:     ${(currentImpliedProb * 100).toFixed(2)}%`);
        console.log(`   ⚡ Edge:             ${(edge * 100).toFixed(2)}%`);
        console.log(`   💬 Reasoning: ${prediction.reasoning}`);

        // ── 3. Check minimum edge threshold ─────────────────────────────
        if (Math.abs(edge) < MIN_EDGE_THRESHOLD) {
            console.log(`   ⏭️  Edge (${(edge * 100).toFixed(2)}%) below threshold (${(MIN_EDGE_THRESHOLD * 100)}%). Skipping.`);
            continue;
        }

        // Determine which outcome to buy: 0 (YES) if we're bullish, 1 (NO) if bearish
        const outcomeIdx = edge > 0 ? 0 : 1;
        const effectiveProb = edge > 0 ? prediction.probability : (1 - prediction.probability);
        const effectiveMarketPrice = edge > 0 ? currentImpliedProb : (1 - currentImpliedProb);

        // ── 4. Risk Management: Kelly sizing ────────────────────────────
        const betSize = calculatePositionSize(effectiveProb, effectiveMarketPrice, bankroll, FRACTIONAL_KELLY);
        console.log(`   🎯 Kelly Bet Size: ${betSize.toFixed(4)} tokens (on outcome ${outcomeIdx}: ${market.outcomes[outcomeIdx]})`);

        if (betSize <= 0) {
            console.log(`   ⏭️  Kelly says no bet. Skipping.`);
            continue;
        }

        tradesAttempted++;

        // ── 5. Execution: Quote, check slippage, execute ────────────────
        // Shares use 18 decimals, tokens use 6 decimals
        const sharesOut = BigInt(Math.round(betSize * Math.pow(10, SHARE_DECIMALS)));

        const expectedTokensIn = await getSlippageQuote(
            market.address as `0x${string}`,
            outcomeIdx,
            sharesOut
        );

        if (!expectedTokensIn) {
            console.warn(`   ❌ Quote failed. Skipping trade.`);
            continue;
        }

        // Apply slippage tolerance using basis points (matching the official skills approach)
        const slippageBps = BigInt(MAX_SLIPPAGE_BPS);
        const maxTokensIn = expectedTokensIn * (10_000n + slippageBps) / 10_000n;

        const costHuman = (Number(expectedTokensIn) / 1e6).toFixed(6);
        const maxCostHuman = (Number(maxTokensIn) / 1e6).toFixed(6);
        console.log(`   💵 Estimated Cost: ${costHuman} TST (max with slippage: ${maxCostHuman} TST)`);

        // Safety check: don't spend more than 10% of bankroll on one trade
        const maxSpendTokens = bankroll * 0.10;
        if (Number(maxTokensIn) / 1e6 > maxSpendTokens) {
            console.warn(`   ❌ Trade cost (${maxCostHuman} TST) exceeds 10% of bankroll (${maxSpendTokens.toFixed(2)} TST). Skipping.`);
            continue;
        }

        if (DRY_RUN) {
            console.log(`   🏜️  DRY RUN — Would buy ${(Number(sharesOut) / 1e18).toFixed(4)} shares of outcome ${outcomeIdx} (${market.outcomes[outcomeIdx]}) for ~${costHuman} TST.`);
        } else {
            console.log(`   🚀 Executing trade...`);
            const txHash = await executeTrade(
                market.address as `0x${string}`,
                outcomeIdx,
                sharesOut,
                maxTokensIn // Use max (with slippage) as the cap
            );
            if (txHash) {
                tradesExecuted++;
            }
        }
    }

    // ── Sweep settled positions ─────────────────────────────────────────
    await sweepSettledPositions();

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`✅ Loop complete. Trades attempted: ${tradesAttempted}, Executed: ${tradesExecuted}`);
    console.log(`⏳ Next run in ${POLL_INTERVAL_MS / 1000}s...`);
    console.log(`${'═'.repeat(70)}\n`);
}

// ─── Entry Point ─────────────────────────────────────────────────────────────
async function main() {
    console.log(`
    ╔══════════════════════════════════════════╗
    ║   DELPHI AUTONOMOUS TRADING AGENT        ║
    ║   Gensyn Agent Arena — Competition       ║
    ╚══════════════════════════════════════════╝
    `);

    if (DRY_RUN) {
        console.log("⚠️  DRY RUN MODE ENABLED — No real trades will be executed.\n");
    }

    await initDatabase();
    console.log("✅ SQLite database initialized.");

    // Run immediately
    await runLoop();

    // Then on interval
    setInterval(runLoop, POLL_INTERVAL_MS);
}

main().catch(console.error);
