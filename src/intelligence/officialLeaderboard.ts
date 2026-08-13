/**
 * Official leaderboard fetcher.
 *
 * The competition site (competition.delphi.fyi) server-renders the full
 * leaderboard — rank, wallet address, name, account value, PnL — inside its
 * Next.js flight payload. This parses it directly, so our rank/gap numbers
 * match the site exactly instead of approximating from subgraph flows.
 */

export interface LeaderboardRow {
    rank: number;
    address: string;
    name: string;
    accountValue: number;
    pnl: number;
    tradesCount: number;
}

let cache: { at: number; rows: LeaderboardRow[] } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function fetchOfficialLeaderboard(): Promise<LeaderboardRow[]> {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;

    const res = await fetch('https://competition.delphi.fyi/', {
        signal: AbortSignal.timeout(15_000),
        headers: { 'User-Agent': 'Mozilla/5.0 (MHA-agent)' },
    });
    if (!res.ok) throw new Error(`leaderboard page returned ${res.status}`);
    const html = await res.text();

    // The flight payload escapes quotes (\") — unescape, then pull each row.
    const s = html.replace(/\\"/g, '"');
    const re = /\{"rank":(\d+),"rankChange":-?\d+,"address":"(0x[0-9a-fA-F]{40})","name":"([^"]*)","accountValue":([0-9.eE+-]+),"cash":[0-9.eE+-]+,"pnl":([0-9.eE+-]+),"tradesVolume":[0-9.eE+-]+,"tradesCount":(\d+)/g;

    const rows: LeaderboardRow[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
        rows.push({
            rank: Number(m[1]),
            address: m[2]!.toLowerCase(),
            name: m[3]!,
            accountValue: Number(m[4]),
            pnl: Number(m[5]),
            tradesCount: Number(m[6]),
        });
    }

    if (rows.length === 0) throw new Error('no leaderboard rows parsed — page layout may have changed');

    // Dedup (the payload can repeat rows across page sections)
    const byAddr = new Map<string, LeaderboardRow>();
    for (const r of rows) if (!byAddr.has(r.address)) byAddr.set(r.address, r);
    const deduped = [...byAddr.values()].sort((a, b) => a.rank - b.rank);

    cache = { at: Date.now(), rows: deduped };
    return deduped;
}
