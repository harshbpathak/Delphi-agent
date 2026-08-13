import { delphiClient } from '../execution/delphiClient.js';
import { getState, setState, storeCompetitorTrades, marketFlowFromDb, walletNetByMarket } from '../persistence/db.js';
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
/** Pull all new trades (every wallet) since the last poll into competitor_trades.
 *  Paginates up to MAX_PAGES per call so the initial backfill of the whole
 *  competition history completes within a couple of loops. */
export async function pollAllTrades() {
    const MAX_PAGES = 8;
    let total = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
        const stored = await pollTradesPage();
        total += stored;
        if (stored < POLL_PAGE)
            break; // caught up
    }
    return total;
}
async function pollTradesPage() {
    const subgraph = delphiClient.getSubgraph();
    const sinceTs = Number(await getState('tradePollerLastTs')) || 0;
    let stored = 0;
    let maxTs = sinceTs;
    try {
        const data = await subgraph.query(`
            query Recent($since: BigInt!) {
                gatewayBuys(first: ${POLL_PAGE}, orderBy: timestamp_, orderDirection: asc,
                            where: { timestamp__gt: $since }) {
                    id timestamp_ marketProxy buyer outcomeIdx tokensIn sharesOut
                }
                gatewaySells(first: ${POLL_PAGE}, orderBy: timestamp_, orderDirection: asc,
                             where: { timestamp__gt: $since }) {
                    id timestamp_ marketProxy seller outcomeIdx sharesIn tokensOut
                }
            }`, { since: String(sinceTs) });
        const rows = [];
        for (const b of data.gatewayBuys || []) {
            const ts = Number(b.timestamp_);
            maxTs = Math.max(maxTs, ts);
            rows.push({
                id: b.id, wallet: (b.buyer || '').toLowerCase(), market: (b.marketProxy || '').toLowerCase(),
                side: 'buy', outcomeIdx: Number(b.outcomeIdx ?? -1),
                tokens: Number(b.tokensIn || 0) / 1e6, shares: Number(b.sharesOut || 0) / 1e18, ts,
            });
        }
        for (const s of data.gatewaySells || []) {
            const ts = Number(s.timestamp_);
            maxTs = Math.max(maxTs, ts);
            rows.push({
                id: s.id, wallet: (s.seller || '').toLowerCase(), market: (s.marketProxy || '').toLowerCase(),
                side: 'sell', outcomeIdx: Number(s.outcomeIdx ?? -1),
                tokens: Number(s.tokensOut || 0) / 1e6, shares: Number(s.sharesIn || 0) / 1e18, ts,
            });
        }
        // Redemptions & liquidations complete the realized-PnL picture.
        // Queried separately: if field names differ on this subgraph the
        // failure degrades to buys/sells-only standings instead of breaking.
        try {
            const exits = await subgraph.query(`
                query Exits($since: BigInt!) {
                    gatewayRedemptions(first: ${POLL_PAGE}, orderBy: timestamp_, orderDirection: asc,
                                       where: { timestamp__gt: $since }) {
                        id timestamp_ marketProxy redeemer tokensOut
                    }
                    gatewayLiquidations(first: ${POLL_PAGE}, orderBy: timestamp_, orderDirection: asc,
                                        where: { timestamp__gt: $since }) {
                        id timestamp_ marketProxy liquidator totalTokensOut
                    }
                }`, { since: String(sinceTs) });
            for (const r of exits.gatewayRedemptions || []) {
                const ts = Number(r.timestamp_);
                maxTs = Math.max(maxTs, ts);
                rows.push({
                    id: r.id, wallet: (r.redeemer || '').toLowerCase(), market: (r.marketProxy || '').toLowerCase(),
                    side: 'redeem', outcomeIdx: -1, tokens: Number(r.tokensOut || 0) / 1e6, shares: 0, ts,
                });
            }
            for (const l of exits.gatewayLiquidations || []) {
                const ts = Number(l.timestamp_);
                maxTs = Math.max(maxTs, ts);
                rows.push({
                    id: l.id, wallet: (l.liquidator || '').toLowerCase(), market: (l.marketProxy || '').toLowerCase(),
                    side: 'liquidate', outcomeIdx: -1, tokens: Number(l.totalTokensOut || 0) / 1e6, shares: 0, ts,
                });
            }
        }
        catch (e) {
            console.warn('  [Context] Exit-event poll failed (standings will be flow-only):', e.message?.slice(0, 120));
        }
        if (rows.length > 0) {
            stored = await storeCompetitorTrades(rows);
            await setState('tradePollerLastTs', String(maxTs));
        }
    }
    catch (e) {
        console.warn('  [Context] Trade poller failed:', e.message?.slice(0, 150));
    }
    return stored;
}
export async function getMarketFlow(marketAddress) {
    const addr = marketAddress.toLowerCase();
    const flow = await marketFlowFromDb(addr, Date.now() / 1000 - 86_400);
    const holders = await walletNetByMarket(addr);
    const topHolders = holders
        .filter(h => h.netShares > 0.01)
        .sort((a, b) => b.netShares - a.netShares)
        .slice(0, 5);
    const crowd0 = topHolders.filter(h => h.outcomeIdx === 0).reduce((s, h) => s + h.netShares, 0);
    const crowd1 = topHolders.filter(h => h.outcomeIdx === 1).reduce((s, h) => s + h.netShares, 0);
    const summary = `Last 24h: ${flow.trades} trades by ${flow.uniqueWallets} agents. ` +
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
/**
 * Computes an approximate leaderboard from stored trades + redemptions.
 * PnL = realized flow + Σ(open shares × current price). Matches the official
 * ranking formula; small drift comes from markets outside our price scan.
 */
export async function computeStandings(openMarkets) {
    const priceByMarket = new Map();
    for (const m of openMarkets)
        priceByMarket.set(m.address.toLowerCase(), m.spotPrices);
    const { walletAggregates, netPositions } = await import('../persistence/db.js').then(db => db.standingsData());
    const standings = [];
    for (const w of walletAggregates) {
        let openMark = 0;
        for (const p of netPositions.filter(p => p.wallet === w.wallet && p.netShares > 0.01)) {
            const prices = priceByMarket.get(p.market);
            if (prices && prices[p.outcomeIdx] !== undefined) {
                openMark += p.netShares * prices[p.outcomeIdx];
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
export async function getCompetitionPosture(openMarkets) {
    try {
        const signer = await delphiClient.getSigner();
        const us = signer.address.toLowerCase();
        const standings = await computeStandings(openMarkets);
        const ourIdx = standings.findIndex(s => s.wallet === us);
        const leader = standings[0] ?? null;
        const ours = ourIdx >= 0 ? standings[ourIdx] : null;
        const posture = {
            ourRank: ourIdx >= 0 ? ourIdx + 1 : null,
            ourPnl: ours?.pnl ?? 0,
            leaderPnl: leader?.pnl ?? 0,
            leaderWallet: leader?.wallet ?? null,
            gapToLeader: (leader?.pnl ?? 0) - (ours?.pnl ?? 0),
            summary: '',
        };
        posture.summary = `Rank ${posture.ourRank ?? '?'}/${standings.length} | our PnL ${posture.ourPnl.toFixed(1)} | leader ${posture.leaderPnl.toFixed(1)} | gap ${posture.gapToLeader.toFixed(1)} TST`;
        return posture;
    }
    catch (e) {
        return { ourRank: null, ourPnl: 0, leaderPnl: 0, leaderWallet: null, gapToLeader: 0, summary: 'standings unavailable' };
    }
}
