/**
 * Hard-data watchers for every REAL-WORLD holding, on a polling basis.
 *
 * Each loop, every open position's market is matched against known
 * primary-data patterns (auto-detected from the question/criteria text — no
 * per-market configuration):
 *
 *   - USGS gauge questions   → poll the USGS Water Services API hourly,
 *                              project the reading at the deadline from the
 *                              recent trend.
 *   - CoinGecko close        → poll the CoinGecko price API hourly, convert
 *     questions                distance-to-threshold into a probability via a
 *                              lognormal volatility model.
 *   - everything else        → flagged for a forced Gemini+search re-check
 *                              every RECHECK_HOURS (the primary source needs
 *                              reading, not an API).
 *
 * Watcher output is written into market_evaluations — the same store the
 * exit manager reads — so deteriorating data tightens into an automatic sell
 * with zero human latency.
 */
import { delphiClient } from '../execution/delphiClient.js';
import { saveEvaluation, getState, setState } from '../persistence/db.js';
import { logEvent } from '../observability/eventLog.js';
import { EnrichedMarket } from '../execution/marketScanner.js';

const CHECK_INTERVAL_MS = 60 * 60 * 1000;   // hard-data polls: hourly per market
export const RECHECK_HOURS = 3;             // LLM re-check cadence for other held markets

/** Held markets with no hard-data source — the evaluator re-checks these every RECHECK_HOURS. */
export const heldMarketsNeedingRecheck = new Set<string>();

// ─── math helpers ────────────────────────────────────────────────────────────
function normCdf(z: number): number {
    // Abramowitz-Stegun erf approximation
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    if (z > 0) p = 1 - p;
    return p;
}
const clampP = (p: number) => Math.min(0.98, Math.max(0.02, p));

// ─── USGS gauge watcher ──────────────────────────────────────────────────────
interface UsgsSpec { site: string; threshold: number; outcome0IsBelow: boolean; deadline: number }

function detectUsgs(m: EnrichedMarket): UsgsSpec | null {
    const text = `${m.question}\n${m.resolutionContext || ''}`;
    const site = text.match(/site\s+(\d{7,8})/i)?.[1];
    const thr = text.match(/below\s+([\d,]+)\s*cfs/i)?.[1] ?? text.match(/([\d,]+)\s*cfs/i)?.[1];
    const ts = text.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z?)/)?.[1];
    if (!site || !thr) return null;
    const deadline = ts ? Date.parse(ts.endsWith('Z') ? ts : ts + 'Z') : Date.parse(m.resolvesAt || '');
    if (isNaN(deadline)) return null;
    return {
        site,
        threshold: Number(thr.replace(/,/g, '')),
        outcome0IsBelow: /below/i.test(m.question) === /yes/i.test(m.outcomes[0] || 'yes'),
        deadline,
    };
}

async function runUsgs(m: EnrichedMarket, spec: UsgsSpec): Promise<void> {
    if (Date.now() > spec.deadline) return;
    const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${spec.site}&parameterCd=00060&period=P5D`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`USGS ${res.status}`);
    const data: any = await res.json();
    const series = (data?.value?.timeSeries?.[0]?.values?.[0]?.value || [])
        .map((x: any) => ({ t: Date.parse(x.dateTime), v: Number(x.value) }))
        .filter((x: any) => isFinite(x.t) && x.v > 0);
    if (series.length < 50) return;

    const now = series[series.length - 1]!;
    const cutoff = now.t - 3 * 86_400_000;
    const past = series.find((s: any) => s.t >= cutoff) || series[0]!;
    const daysSpan = (now.t - past.t) / 86_400_000;
    if (daysSpan < 0.5) return;
    const dailyFactor = Math.pow(now.v / past.v, 1 / daysSpan);
    const projected = now.v * Math.pow(dailyFactor, (spec.deadline - now.t) / 86_400_000);

    const sigma = Math.max(3000, now.v * 0.025); // gauge forecast noise
    const pBelow = clampP(normCdf((spec.threshold - projected) / sigma));
    const p0 = spec.outcome0IsBelow ? pBelow : 1 - pBelow;

    await saveEvaluation(m.address, p0, m.impliedProbabilities[0]!, p0, m.category);
    const msg = `[Watch:USGS ${spec.site}] now ${Math.round(now.v)} | trend ${((dailyFactor - 1) * 100).toFixed(2)}%/day | proj ${Math.round(projected)} vs ${spec.threshold} → P(outcome0)=${(p0 * 100).toFixed(1)}% (mkt ${(m.impliedProbabilities[0]! * 100).toFixed(1)}%)`;
    console.log(`  ${msg}`);
    logEvent('THINK', msg);
}

// ─── CoinGecko close watcher ─────────────────────────────────────────────────
const COIN_IDS: Record<string, string> = {
    bitcoin: 'bitcoin', btc: 'bitcoin', ethereum: 'ethereum', eth: 'ethereum',
    solana: 'solana', sol: 'solana', dogecoin: 'dogecoin', xrp: 'ripple',
    cardano: 'cardano', bnb: 'binancecoin',
};

interface CryptoSpec { coinId: string; threshold: number; outcome0IsAbove: boolean; measureTs: number }

function detectCrypto(m: EnrichedMarket): CryptoSpec | null {
    const q = m.question;
    if (!/coingecko|daily close/i.test(q)) return null;
    const coinWord = Object.keys(COIN_IDS).find(c => new RegExp(`\\b${c}\\b`, 'i').test(q));
    const thr = q.match(/\$\s*([\d,]+(?:\.\d+)?)/)?.[1];
    const date = q.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!coinWord || !thr || !date) return null;
    return {
        coinId: COIN_IDS[coinWord]!,
        threshold: Number(thr.replace(/,/g, '')),
        outcome0IsAbove: /or higher|at or above|greater|≥|>=/i.test(q),
        // The daily close for day D is fixed at D+1 00:00 UTC
        measureTs: Date.parse(date + 'T00:00:00Z') + 86_400_000,
    };
}

async function runCrypto(m: EnrichedMarket, spec: CryptoSpec): Promise<void> {
    if (Date.now() > spec.measureTs) return;
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${spec.coinId}&vs_currencies=usd`,
        { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const data: any = await res.json();
    const price = data?.[spec.coinId]?.usd;
    if (!price) return;

    const days = Math.max(0.02, (spec.measureTs - Date.now()) / 86_400_000);
    const vol = 0.035 * Math.sqrt(days); // ~3.5% daily lognormal vol for majors
    const z = Math.log(spec.threshold / price) / vol;
    const pAbove = clampP(1 - normCdf(z));
    const p0 = spec.outcome0IsAbove ? pAbove : 1 - pAbove;

    await saveEvaluation(m.address, p0, m.impliedProbabilities[0]!, p0, m.category);
    const msg = `[Watch:${spec.coinId}] price $${price} vs $${spec.threshold} close in ${days.toFixed(2)}d → P(outcome0)=${(p0 * 100).toFixed(1)}% (mkt ${(m.impliedProbabilities[0]! * 100).toFixed(1)}%)`;
    console.log(`  ${msg}`);
    logEvent('THINK', msg);
}

// ─── Orchestrator ────────────────────────────────────────────────────────────
/** Called each loop. Auto-detects a watcher for every open HELD market;
 *  hard-data polls run hourly; unmatched holdings are flagged for LLM
 *  re-checks. Never throws. */
export async function runDataWatchers(markets: EnrichedMarket[]): Promise<void> {
    let held: string[] = [];
    try {
        const signer = await delphiClient.getSigner();
        const { positions } = await delphiClient.listPositions({
            wallet: signer.address,
            redeemedOrLiquidated: false,
        });
        held = (positions || []).map(p => p.marketProxy.toLowerCase());
    } catch { return; }

    heldMarketsNeedingRecheck.clear();

    for (const addr of new Set(held)) {
        const market = markets.find(m => m.address.toLowerCase() === addr);
        if (!market) continue; // closed for trading — brackets can't act anyway

        try {
            const usgs = detectUsgs(market);
            const crypto = usgs ? null : detectCrypto(market);

            if (!usgs && !crypto) {
                heldMarketsNeedingRecheck.add(addr);
                continue;
            }

            const key = `watchLastRun_${addr.slice(0, 12)}`;
            const last = Number(await getState(key)) || 0;
            if (Date.now() - last < CHECK_INTERVAL_MS) continue;
            await setState(key, String(Date.now()));

            if (usgs) await runUsgs(market, usgs);
            else if (crypto) await runCrypto(market, crypto);
        } catch (e) {
            console.warn(`  [Watch] ${addr.slice(0, 10)} failed:`, (e as Error).message?.slice(0, 120));
        }
    }
}
