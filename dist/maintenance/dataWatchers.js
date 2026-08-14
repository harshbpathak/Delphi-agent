/**
 * Hard-data watchers: markets whose outcome is a measurable physical quantity
 * get monitored against the PRIMARY data source directly — no LLM, no news.
 *
 * Each watcher fetches the gauge, projects the value at the deadline from the
 * recent trend, converts it to a probability, and writes it into
 * market_evaluations. The exit manager reads those evaluations every loop, so
 * a deteriorating projection automatically tightens into a sell with zero
 * human latency.
 */
import { saveEvaluation } from '../persistence/db.js';
import { getState, setState } from '../persistence/db.js';
import { logEvent } from '../observability/eventLog.js';
const WATCHES = [
    {
        // "Will Mississippi River discharge at Baton Rouge at 12:00 UTC on
        //  Aug 16, 2026 be below 220,000 cfs?" — we hold No (outcome 1).
        marketAddress: '0xb4ded804c9a64fb142313ca171f7c2dfa97baefe',
        usgsSite: '07374000',
        threshold: 220_000,
        outcome0IsBelow: true,
        deadlineIso: '2026-08-16T12:00:00Z',
        sigma: 6_000,
        label: 'Mississippi @ Baton Rouge',
    },
];
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly per watch
const normCdf = (z) => 0.5 * (1 + Math.tanh(Math.sqrt(Math.PI / 8) * z * 2 / Math.SQRT2));
async function fetchUsgsSeries(site) {
    const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${site}&parameterCd=00060&period=P5D`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok)
        throw new Error(`USGS ${res.status}`);
    const data = await res.json();
    const values = data?.value?.timeSeries?.[0]?.values?.[0]?.value || [];
    return values
        .map((x) => ({ t: Date.parse(x.dateTime), v: Number(x.value) }))
        .filter((x) => isFinite(x.t) && x.v > 0);
}
async function runWatch(w, market) {
    const deadline = Date.parse(w.deadlineIso);
    if (Date.now() > deadline)
        return; // question decided; nothing to project
    if (!market)
        return; // market not open — brackets can't act anyway
    const series = await fetchUsgsSeries(w.usgsSite);
    if (series.length < 50)
        return;
    const now = series[series.length - 1];
    // Trend from the last 3 days (exponential recession fit on endpoints).
    const cutoff = now.t - 3 * 86_400_000;
    const past = series.find(s => s.t >= cutoff) || series[0];
    const daysSpan = (now.t - past.t) / 86_400_000;
    if (daysSpan < 0.5)
        return;
    const dailyFactor = Math.pow(now.v / past.v, 1 / daysSpan);
    const daysToDeadline = (deadline - now.t) / 86_400_000;
    const projected = now.v * Math.pow(dailyFactor, daysToDeadline);
    // P(value below threshold at deadline)
    const z = (w.threshold - projected) / w.sigma;
    const pBelow = Math.min(0.98, Math.max(0.02, normCdf(z)));
    const p0 = w.outcome0IsBelow ? pBelow : 1 - pBelow;
    await saveEvaluation(market.address, p0, market.impliedProbabilities[0], p0, market.category);
    const msg = `[Watch:${w.label}] now ${Math.round(now.v)} | trend ${((dailyFactor - 1) * 100).toFixed(2)}%/day | projected ${Math.round(projected)} at deadline vs ${w.threshold} → P(outcome0)=${(p0 * 100).toFixed(1)}% (market ${(market.impliedProbabilities[0] * 100).toFixed(1)}%)`;
    console.log(`  ${msg}`);
    logEvent('THINK', msg);
}
/** Called each loop; each watch runs at most hourly and never throws. */
export async function runDataWatchers(markets) {
    for (const w of WATCHES) {
        try {
            const key = `watchLastRun_${w.usgsSite}_${w.marketAddress.slice(0, 10)}`;
            const last = Number(await getState(key)) || 0;
            if (Date.now() - last < CHECK_INTERVAL_MS)
                continue;
            await setState(key, String(Date.now()));
            const market = markets.find(m => m.address.toLowerCase() === w.marketAddress);
            await runWatch(w, market);
        }
        catch (e) {
            console.warn(`  [Watch] ${w.label} failed:`, e.message?.slice(0, 120));
        }
    }
}
