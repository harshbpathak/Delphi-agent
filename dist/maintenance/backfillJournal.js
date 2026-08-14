/**
 * Backfills the local trade journal from the on-chain trade mirror.
 *
 * Positions opened by the v1 agent (before the journal existed) have no cost
 * basis locally, which means:
 *   - the take-profit / stop-loss brackets skip them (no entry price), and
 *   - any settlement already recorded for them computed PnL against zero cost,
 *     overstating profit and misleading the circuit breaker + calibration gate.
 *
 * This reconstructs both from `competitor_trades` (our own rows in the
 * subgraph mirror), which is authoritative on-chain history. Idempotent:
 * only the shortfall between on-chain and journalled shares is inserted.
 *
 * Run: node dist/maintenance/backfillJournal.js
 */
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'node:path';
import { delphiClient } from '../execution/delphiClient.js';
const EPS = 0.01;
async function main() {
    const db = await open({ filename: path.resolve('./articles.sqlite'), driver: sqlite3.Database });
    const signer = await delphiClient.getSigner();
    const us = signer.address.toLowerCase();
    // ── 1. Journal backfill ──────────────────────────────────────────────
    const onchain = await db.all(`SELECT market, outcome_idx AS outcomeIdx,
                SUM(CASE WHEN side='buy' THEN shares ELSE 0 END) AS shares,
                SUM(CASE WHEN side='buy' THEN tokens ELSE 0 END) AS tokens,
                MIN(ts) AS firstTs
         FROM competitor_trades
         WHERE wallet = ? AND side = 'buy'
         GROUP BY market, outcome_idx`, [us]);
    let inserted = 0;
    for (const row of onchain) {
        const j = await db.get(`SELECT COALESCE(SUM(shares),0) AS shares, COALESCE(SUM(cost_tokens),0) AS cost
             FROM trades WHERE market_address = ? AND outcome_idx = ? AND dry_run = 0`, [row.market, row.outcomeIdx]);
        const missingShares = row.shares - (j?.shares || 0);
        if (missingShares <= EPS)
            continue;
        const avgPrice = row.tokens / row.shares;
        const missingCost = missingShares * avgPrice;
        let question = '(backfilled from chain)';
        let category = 'unknown';
        let label = `outcome ${row.outcomeIdx}`;
        try {
            const m = await delphiClient.getMarket({ id: row.market });
            question = m.metadata?.question || question;
            category = m.category || category;
            label = m.metadata?.outcomes?.[row.outcomeIdx] || label;
        }
        catch { /* market may be outside the active competition */ }
        await db.run(`INSERT INTO trades (market_address, question, category, outcome_idx, outcome_label,
                predicted_prob, market_price, effective_price, shares, cost_tokens, dry_run, tx_hash, created_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, 'backfill', ?)`, [row.market, question, category, row.outcomeIdx, label,
            avgPrice, avgPrice, missingShares, missingCost, row.firstTs * 1000]);
        inserted++;
        console.log(`+ journal: ${missingShares.toFixed(2)} sh @ ${avgPrice.toFixed(4)} = ${missingCost.toFixed(2)} TST — "${question.slice(0, 55)}"`);
    }
    // ── 2. Repair settlement PnL ─────────────────────────────────────────
    // Cost basis = everything we SPENT on that market up to the exit. Sells
    // must NOT be netted out here: the exit sale is itself recorded as the
    // settlement's proceeds, so subtracting it would zero the cost and report
    // the entire sale as profit.
    const settlements = await db.all(`SELECT id, market_address, proceeds_tokens, cost_tokens, settled_at FROM settlements`);
    let repaired = 0;
    for (const s of settlements) {
        const tsCut = Math.floor(s.settled_at / 1000);
        const agg = await db.get(`SELECT COALESCE(SUM(tokens),0) AS bought
             FROM competitor_trades
             WHERE wallet = ? AND market = ? AND side = 'buy' AND ts <= ?`, [us, s.market_address.toLowerCase(), tsCut]);
        const trueCost = agg?.bought || 0;
        if (Math.abs(trueCost - s.cost_tokens) <= EPS)
            continue;
        const pnl = s.proceeds_tokens - trueCost;
        await db.run(`UPDATE settlements SET cost_tokens = ?, pnl_tokens = ? WHERE id = ?`, [trueCost, pnl, s.id]);
        repaired++;
        console.log(`~ settlement #${s.id}: cost ${s.cost_tokens.toFixed(2)} → ${trueCost.toFixed(2)}, PnL → ${pnl.toFixed(2)} TST`);
    }
    const check = await db.get(`SELECT COUNT(*) n, COALESCE(SUM(pnl_tokens),0) pnl,
                COALESCE(SUM(CASE WHEN pnl_tokens > 0 THEN 1 ELSE 0 END),0) wins FROM settlements`);
    console.log(`\nBackfilled ${inserted} journal row(s), repaired ${repaired} settlement(s).`);
    console.log(`Journal now: ${check.n} closed positions, ${check.wins} wins, net PnL ${check.pnl.toFixed(2)} TST`);
    await db.close();
}
main().catch(e => { console.error('Backfill failed:', e); process.exit(1); });
