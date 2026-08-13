import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';

let db: Database<sqlite3.Database, sqlite3.Statement>;

export async function initDatabase() {
    db = await open({
        filename: path.resolve('./articles.sqlite'),
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS processed_articles (
            id TEXT PRIMARY KEY,
            title TEXT,
            link TEXT,
            pubDate TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS agent_state (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS market_evaluations (
            market_address TEXT PRIMARY KEY,
            predicted_prob REAL,
            market_price REAL,
            evaluated_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            market_address TEXT NOT NULL,
            question TEXT,
            category TEXT,
            outcome_idx INTEGER,
            outcome_label TEXT,
            predicted_prob REAL,
            market_price REAL,
            effective_price REAL,
            shares REAL,
            cost_tokens REAL,
            dry_run INTEGER DEFAULT 0,
            tx_hash TEXT,
            created_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS competitor_trades (
            id TEXT PRIMARY KEY,          -- subgraph event id
            wallet TEXT NOT NULL,
            market TEXT NOT NULL,
            side TEXT NOT NULL,           -- 'buy' | 'sell' | 'redeem' | 'liquidate'
            outcome_idx INTEGER,
            tokens REAL,
            shares REAL,
            ts INTEGER                    -- unix seconds
        );
        CREATE INDEX IF NOT EXISTS idx_ct_market ON competitor_trades(market, ts);
        CREATE INDEX IF NOT EXISTS idx_ct_wallet ON competitor_trades(wallet);

        CREATE TABLE IF NOT EXISTS settlements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            market_address TEXT NOT NULL,
            kind TEXT,               -- 'redeem' | 'liquidate'
            proceeds_tokens REAL,
            cost_tokens REAL,
            pnl_tokens REAL,
            settled_at INTEGER
        );
    `);
}

// ─── Article dedup ───────────────────────────────────────────────────────────
export async function isArticleProcessed(id: string): Promise<boolean> {
    const row = await db.get('SELECT id FROM processed_articles WHERE id = ?', [id]);
    return !!row;
}

export async function markArticleProcessed(id: string, title: string, link: string, pubDate: string) {
    await db.run(
        'INSERT OR IGNORE INTO processed_articles (id, title, link, pubDate) VALUES (?, ?, ?, ?)',
        [id, title, link, pubDate]
    );
}

// ─── Key/value agent state (persisted counters, halt flag) ───────────────────
export async function getState(key: string): Promise<string | null> {
    const row = await db.get('SELECT value FROM agent_state WHERE key = ?', [key]);
    return row ? row.value : null;
}

export async function setState(key: string, value: string) {
    await db.run(
        'INSERT INTO agent_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, value]
    );
}

// ─── Market evaluations (for price-move re-evaluation triggers) ──────────────
export interface MarketEvaluation {
    predicted_prob: number;
    market_price: number;
    evaluated_at: number;
}

export async function getLastEvaluation(marketAddress: string): Promise<MarketEvaluation | null> {
    const row = await db.get(
        'SELECT predicted_prob, market_price, evaluated_at FROM market_evaluations WHERE market_address = ?',
        [marketAddress]
    );
    return row || null;
}

export async function saveEvaluation(marketAddress: string, predictedProb: number, marketPrice: number) {
    await db.run(
        `INSERT INTO market_evaluations (market_address, predicted_prob, market_price, evaluated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(market_address) DO UPDATE SET
            predicted_prob = excluded.predicted_prob,
            market_price = excluded.market_price,
            evaluated_at = excluded.evaluated_at`,
        [marketAddress, predictedProb, marketPrice, Date.now()]
    );
}

// ─── Trade journal ───────────────────────────────────────────────────────────
export interface TradeRecord {
    marketAddress: string;
    question: string;
    category: string;
    outcomeIdx: number;
    outcomeLabel: string;
    predictedProb: number;
    marketPrice: number;
    effectivePrice: number;
    shares: number;
    costTokens: number;
    dryRun: boolean;
    txHash: string | null;
}

export async function recordTrade(t: TradeRecord) {
    await db.run(
        `INSERT INTO trades (market_address, question, category, outcome_idx, outcome_label,
            predicted_prob, market_price, effective_price, shares, cost_tokens, dry_run, tx_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [t.marketAddress, t.question, t.category, t.outcomeIdx, t.outcomeLabel,
         t.predictedProb, t.marketPrice, t.effectivePrice, t.shares, t.costTokens,
         t.dryRun ? 1 : 0, t.txHash, Date.now()]
    );
}

/** Total real (non-dry-run) tokens spent on a market that has not yet been settled in the journal. */
export async function getOpenCost(marketAddress: string): Promise<number> {
    const row = await db.get(
        `SELECT COALESCE(SUM(cost_tokens), 0) AS cost FROM trades
         WHERE market_address = ? AND dry_run = 0
           AND market_address NOT IN (SELECT market_address FROM settlements)`,
        [marketAddress]
    );
    return row?.cost || 0;
}

export async function recordSettlement(marketAddress: string, kind: 'redeem' | 'liquidate' | 'sell', proceedsTokens: number) {
    const cost = await getOpenCost(marketAddress);
    await db.run(
        `INSERT INTO settlements (market_address, kind, proceeds_tokens, cost_tokens, pnl_tokens, settled_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [marketAddress, kind, proceedsTokens, cost, proceedsTokens - cost, Date.now()]
    );
}

/** Open (unsettled) real cost per category — for correlation/exposure caps. */
export async function openCostByCategory(): Promise<Record<string, number>> {
    const rows = await db.all(
        `SELECT category, COALESCE(SUM(cost_tokens), 0) AS cost FROM trades
         WHERE dry_run = 0
           AND market_address NOT IN (SELECT market_address FROM settlements)
         GROUP BY category`
    );
    const out: Record<string, number> = {};
    for (const r of rows as any[]) out[r.category || 'unknown'] = r.cost;
    return out;
}

/** Net PnL over the most recent N settled positions (real trades only). */
export async function recentSettledPnl(lastN: number): Promise<{ count: number; netPnl: number }> {
    const rows = await db.all(
        `SELECT pnl_tokens FROM settlements ORDER BY settled_at DESC LIMIT ?`,
        [lastN]
    );
    const netPnl = rows.reduce((s: number, r: any) => s + (r.pnl_tokens || 0), 0);
    return { count: rows.length, netPnl };
}

// ─── Competitor intelligence ─────────────────────────────────────────────────
export interface CompetitorTradeRow {
    id: string;
    wallet: string;
    market: string;
    side: 'buy' | 'sell' | 'redeem' | 'liquidate';
    outcomeIdx: number;
    tokens: number;
    shares: number;
    ts: number;
}

export async function storeCompetitorTrades(rows: CompetitorTradeRow[]): Promise<number> {
    let stored = 0;
    for (const r of rows) {
        const res = await db.run(
            `INSERT OR IGNORE INTO competitor_trades (id, wallet, market, side, outcome_idx, tokens, shares, ts)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [r.id, r.wallet, r.market, r.side, r.outcomeIdx, r.tokens, r.shares, r.ts]
        );
        stored += res.changes || 0;
    }
    return stored;
}

export async function marketFlowFromDb(market: string, sinceTs: number): Promise<{
    trades: number; uniqueWallets: number; buyVol0: number; buyVol1: number; sellVol: number;
}> {
    const row = await db.get(
        `SELECT COUNT(*) AS trades,
                COUNT(DISTINCT wallet) AS uniqueWallets,
                COALESCE(SUM(CASE WHEN side='buy' AND outcome_idx=0 THEN tokens END), 0) AS buyVol0,
                COALESCE(SUM(CASE WHEN side='buy' AND outcome_idx=1 THEN tokens END), 0) AS buyVol1,
                COALESCE(SUM(CASE WHEN side='sell' THEN tokens END), 0) AS sellVol
         FROM competitor_trades WHERE market = ? AND ts > ?`,
        [market, sinceTs]
    );
    return {
        trades: row?.trades || 0,
        uniqueWallets: row?.uniqueWallets || 0,
        buyVol0: row?.buyVol0 || 0,
        buyVol1: row?.buyVol1 || 0,
        sellVol: row?.sellVol || 0,
    };
}

/** Net share position per wallet+outcome for one market (buys − sells). */
export async function walletNetByMarket(market: string): Promise<Array<{
    wallet: string; outcomeIdx: number; netShares: number;
}>> {
    const rows = await db.all(
        `SELECT wallet, outcome_idx AS outcomeIdx,
                SUM(CASE WHEN side='buy' THEN shares WHEN side='sell' THEN -shares ELSE 0 END) AS netShares
         FROM competitor_trades
         WHERE market = ? AND side IN ('buy','sell')
         GROUP BY wallet, outcome_idx`,
        [market]
    );
    return rows as any;
}

/** Aggregates for computing an approximate leaderboard. */
export async function standingsData(): Promise<{
    walletAggregates: Array<{ wallet: string; realizedFlow: number; trades: number }>;
    netPositions: Array<{ wallet: string; market: string; outcomeIdx: number; netShares: number }>;
}> {
    const walletAggregates = await db.all(
        `SELECT wallet,
                SUM(CASE WHEN side='buy' THEN -tokens ELSE tokens END) AS realizedFlow,
                COUNT(CASE WHEN side IN ('buy','sell') THEN 1 END) AS trades
         FROM competitor_trades GROUP BY wallet`
    );
    // Open positions: buys − sells per wallet/market/outcome, excluding markets
    // the wallet has already redeemed/liquidated (their exit zeroed the book).
    const netPositions = await db.all(
        `SELECT wallet, market, outcome_idx AS outcomeIdx,
                SUM(CASE WHEN side='buy' THEN shares WHEN side='sell' THEN -shares ELSE 0 END) AS netShares
         FROM competitor_trades ct
         WHERE side IN ('buy','sell')
           AND NOT EXISTS (
                SELECT 1 FROM competitor_trades e
                WHERE e.wallet = ct.wallet AND e.market = ct.market AND e.side IN ('redeem','liquidate')
           )
         GROUP BY wallet, market, outcome_idx`
    );
    return { walletAggregates: walletAggregates as any, netPositions: netPositions as any };
}

/** Simple calibration/performance snapshot for logging. */
export async function performanceSnapshot(): Promise<{ settled: number; netPnl: number; totalTrades: number }> {
    const s = await db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(pnl_tokens), 0) AS pnl FROM settlements`);
    const t = await db.get(`SELECT COUNT(*) AS n FROM trades WHERE dry_run = 0`);
    return { settled: s?.n || 0, netPnl: s?.pnl || 0, totalTrades: t?.n || 0 };
}
