import { delphiClient } from '../execution/delphiClient.js';
import { EnrichedMarket } from '../execution/marketScanner.js';
import { getState, setState, storeCompetitorTrades, CompetitorTradeRow, marketFlowFromDb, walletNetByMarket } from '../persistence/db.js';

/**
 * Market Situation Engine.
 *
 * Before any trade decision the agent builds a picture of the whole market:
 *  - order flow on each market (who is buying what, how hard, how recently)
 *  - competitor positioning and crowding
 *  - competition standings computed from the subgraph (who is winning, our gap)
 *
 * All of it comes from the free Goldsky subgraph the organizers index.
 */

// ─── Trade poller: mirror ALL agents' trades into SQLite ─────────────────────

const POLL_PAGE = 500;

interface RawBuy {
    id: string; timestamp_: string; marketProxy: string | null; buyer: string | null;
    outcomeIdx: string | null; tokensIn: string | null; sharesOut: string | null;
}
interface RawSell {
    id: string; timestamp_: string; marketProxy: string | null; seller: string | null;
    outcomeIdx: string | null; sharesIn: string | null; tokensOut: string | null;
}
interface RawRedemption {
    id: string; timestamp_: string; marketProxy: string | null; redeemer?: string | null;
    wallet?: string | null; tokensOut?: string | null;
}

interface EntitySpec {
    entity: string;
    cursorKey: string;
    fields: string;
    map: (r: any, ts: number) => CompetitorTradeRow;
}

// Each entity gets its OWN timestamp cursor. A shared cursor skips events:
// when one stream is denser than another, advancing past the sparser
// stream's page horizon drops everything in between.
const ENTITIES: EntitySpec[] = [
    {
        entity: 'gatewayBuys', cursorKey: 'pollTs_buys',
        fields: 'id timestamp_ marketProxy buyer outcomeIdx tokensIn sharesOut',
        map: (b, ts) => ({
            id: b.id, wallet: (b.buyer || '').toLowerCase(), market: (b.marketProxy || '').toLowerCase(),
            side: 'buy', outcomeIdx: Number(b.outcomeIdx ?? -1),
            tokens: Number(b.tokensIn || 0) / 1e6, shares: Number(b.sharesOut || 0) / 1e18, ts,
        }),
    },
    {
        entity: 'gatewaySells', cursorKey: 'pollTs_sells',
        fields: 'id timestamp_ marketProxy seller outcomeIdx sharesIn tokensOut',
        map: (s, ts) => ({
            id: s.id, wallet: (s.seller || '').toLowerCase(), market: (s.marketProxy || '').toLowerCase(),
            side: 'sell', outcomeIdx: Number(s.outcomeIdx ?? -1),
            tokens: Number(s.tokensOut || 0) / 1e6, shares: Number(s.sharesIn || 0) / 1e18, ts,
        }),
    },
    {
        entity: 'gatewayRedemptions', cursorKey: 'pollTs_redeems',
        fields: 'id timestamp_ marketProxy redeemer tokensOut',
        map: (r, ts) => ({
            id: r.id, wallet: (r.redeemer || '').toLowerCase(), market: (r.marketProxy || '').toLowerCase(),
            side: 'redeem', outcomeIdx: -1, tokens: Number(r.tokensOut || 0) / 1e6, shares: 0, ts,
        }),
    },
    {
        entity: 'gatewayLiquidations', cursorKey: 'pollTs_liquidations',
        fields: 'id timestamp_ marketProxy liquidator totalTokensOut',
        map: (l, ts) => ({
            id: l.id, wallet: (l.liquidator || '').toLowerCase(), market: (l.marketProxy || '').toLowerCase(),
            side: 'liquidate', outcomeIdx: -1, tokens: Number(l.totalTokensOut || 0) / 1e6, shares: 0, ts,
        }),
    },
];

/** Pull all new events (every wallet) into competitor_trades. Each entity type
 *  paginates independently, up to MAX_PAGES per loop. */
export async function pollAllTrades(): Promise<number> {
    const MAX_PAGES = 8;
    const subgraph = delphiClient.getSubgraph();
    let total = 0;

    for (const spec of ENTITIES) {
        try {
            for (let page = 0; page < MAX_PAGES; page++) {
                const sinceTs = Number(await getState(spec.cursorKey)) || 0;
                const data = await subgraph.query<any>(`
                    query P($since: BigInt!) {
                        ${spec.entity}(first: ${POLL_PAGE}, orderBy: timestamp_, orderDirection: asc,
                                       where: { timestamp__gt: $since }) { ${spec.fields} }
                    }`, { since: String(sinceTs) });

                const raw = data[spec.entity] || [];
                if (raw.length === 0) break;

                let maxTs = sinceTs;
                const rows: CompetitorTradeRow[] = raw.map((r: any) => {
                    const ts = Number(r.timestamp_);
                    maxTs = Math.max(maxTs, ts);
                    return spec.map(r, ts);
                });

                total += await storeCompetitorTrades(rows);
                await setState(spec.cursorKey, String(maxTs));
                if (raw.length < POLL_PAGE) break; // caught up
            }
        } catch (e) {
            console.warn(`  [Context] ${spec.entity} poll failed:`, (e as Error).message?.slice(0, 120));
        }
    }
    return total;
}

// ─── Per-market flow & crowding ──────────────────────────────────────────────

export interface MarketFlowContext {
    trades24h: number;
    uniqueWallets24h: number;
    buyVolOutcome0: number;
    buyVolOutcome1: number;
    sellVol: number;
    /** Net share position per top wallet, for crowding analysis */
    topHolders: Array<{ wallet: string; outcomeIdx: number; netShares: number }>;
    /** Formatted context block for the LLM prompt */
    summary: string;
}

export async function getMarketFlow(marketAddress: string): Promise<MarketFlowContext> {
    const addr = marketAddress.toLowerCase();
    const flow = await marketFlowFromDb(addr, Date.now() / 1000 - 86_400);
    const holders = await walletNetByMarket(addr);

    const topHolders = holders
        .filter(h => h.netShares > 0.01)
        .sort((a, b) => b.netShares - a.netShares)
        .slice(0, 5);

    const crowd0 = topHolders.filter(h => h.outcomeIdx === 0).reduce((s, h) => s + h.netShares, 0);
    const crowd1 = topHolders.filter(h => h.outcomeIdx === 1).reduce((s, h) => s + h.netShares, 0);

    const summary =
        `Last 24h: ${flow.trades} trades by ${flow.uniqueWallets} agents. ` +
        `Buy volume: ${flow.buyVol0.toFixed(1)} tokens on outcome 0 vs ${flow.buyVol1.toFixed(1)} on outcome 1. ` +
        `Top holders lean: ${crowd0.toFixed(1)} shares on outcome 0 vs ${crowd1.toFixed(1)} on outcome 1.`;

    return {
        trades24h: flow.trades,
        uniqueWallets24h: flow.uniqueWallets,
        buyVolOutcome0: flow.buyVol0,
        buyVolOutcome1: flow.buyVol1,
        sellVol: flow.sellVol,
        topHolders,
        summary,
    };
}

// ─── Competition standings (computed from subgraph flows) ────────────────────

export interface WalletStanding {
    wallet: string;
    /** Realized token flow: everything received minus everything spent */
    realizedFlow: number;
    /** Mark-to-market of open positions (only markets with known prices) */
    openMark: number;
    pnl: number;
    trades: number;
}

/**
 * Computes an approximate leaderboard from stored trades + redemptions.
 * PnL = realized flow + Σ(open shares × current price). Matches the official
 * ranking formula; small drift comes from markets outside our price scan.
 */
export async function computeStandings(openMarkets: EnrichedMarket[]): Promise<WalletStanding[]> {
    const priceByMarket = new Map<string, number[]>();
    for (const m of openMarkets) priceByMarket.set(m.address.toLowerCase(), m.spotPrices);

    const { walletAggregates, netPositions } = await import('../persistence/db.js').then(db => db.standingsData());

    const standings: WalletStanding[] = [];
    for (const w of walletAggregates) {
        let openMark = 0;
        for (const p of netPositions.filter(p => p.wallet === w.wallet && p.netShares > 0.01)) {
            const prices = priceByMarket.get(p.market);
            if (prices && prices[p.outcomeIdx] !== undefined) {
                openMark += p.netShares * prices[p.outcomeIdx]!;
            }
        }
        standings.push({
            wallet: w.wallet,
            realizedFlow: w.realizedFlow,
            openMark,
            pnl: w.realizedFlow + openMark,
            trades: w.trades,
        });
    }
    return standings.sort((a, b) => b.pnl - a.pnl);
}

export interface CompetitionPosture {
    ourRank: number | null;
    ourPnl: number;
    leaderPnl: number;
    leaderWallet: string | null;
    gapToLeader: number;
    /** PnL gap to rank #3 — the prize threshold, and the target that matters */
    gapToThird: number;
    summary: string;
}

export async function getCompetitionPosture(openMarkets: EnrichedMarket[]): Promise<CompetitionPosture> {
    const signer = await delphiClient.getSigner().catch(() => null);
    const us = signer?.address.toLowerCase() ?? '';

    // Primary source: the OFFICIAL leaderboard (exact same numbers as the site).
    try {
        const { fetchOfficialLeaderboard } = await import('./officialLeaderboard.js');
        const rows = await fetchOfficialLeaderboard();
        const ours = rows.find(r => r.address === us) ?? null;
        const leader = rows[0] ?? null;
        const third = rows[2] ?? null;
        const posture: CompetitionPosture = {
            ourRank: ours?.rank ?? null,
            ourPnl: ours?.pnl ?? 0,
            leaderPnl: leader?.pnl ?? 0,
            leaderWallet: leader?.address ?? null,
            gapToLeader: (leader?.pnl ?? 0) - (ours?.pnl ?? 0),
            gapToThird: (third?.pnl ?? 0) - (ours?.pnl ?? 0),
            summary: '',
        };
        posture.summary = `[official] Rank ${posture.ourRank ?? '?'}/${rows.length} | our PnL ${posture.ourPnl.toFixed(2)} | #3 gap ${posture.gapToThird.toFixed(1)} | leader "${leader?.name}" gap ${posture.gapToLeader.toFixed(1)} TST`;
        return posture;
    } catch (e) {
        console.warn('  [Context] Official leaderboard fetch failed, falling back to subgraph estimate:', (e as Error).message?.slice(0, 120));
    }

    // Fallback: approximate standings from subgraph flows.
    try {
        const standings = await computeStandings(openMarkets);
        const ourIdx = standings.findIndex(s => s.wallet === us);
        const leader = standings[0] ?? null;
        const ours = ourIdx >= 0 ? standings[ourIdx]! : null;

        const posture: CompetitionPosture = {
            ourRank: ourIdx >= 0 ? ourIdx + 1 : null,
            ourPnl: ours?.pnl ?? 0,
            leaderPnl: leader?.pnl ?? 0,
            leaderWallet: leader?.wallet ?? null,
            gapToLeader: (leader?.pnl ?? 0) - (ours?.pnl ?? 0),
            gapToThird: (standings[2]?.pnl ?? 0) - (ours?.pnl ?? 0),
            summary: '',
        };
        posture.summary = `[estimate] Rank ${posture.ourRank ?? '?'}/${standings.length} | our PnL ${posture.ourPnl.toFixed(1)} | leader ${posture.leaderPnl.toFixed(1)} | gap ${posture.gapToLeader.toFixed(1)} TST`;
        return posture;
    } catch {
        return { ourRank: null, ourPnl: 0, leaderPnl: 0, leaderWallet: null, gapToLeader: 0, gapToThird: 0, summary: 'standings unavailable' };
    }
}
