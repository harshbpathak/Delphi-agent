/**
 * Consensus-weight self-calibration (ML Option 2).
 *
 * Every evaluation stores our RAW probability and the market price at the
 * time. When those markets settle, each becomes a labeled example:
 * did outcome 0 win? The job then grid-searches the market-blend weight w
 * that minimizes log-loss of
 *
 *     p = sigmoid( (1-w)·logit(raw) + w·logit(market) )
 *
 * over the settled sample — i.e. it LEARNS how much to trust our oracle vs
 * the crowd, globally and per category, instead of hand-tuning it. The
 * learned base weight feeds the consensus dampener; all safety adders
 * (ambiguity, huge-disagreement, verified-fact) stay on top of it.
 *
 * Honest-small-data rules: global fit needs ≥12 settled samples, a category
 * fit needs ≥15; below that the hand-tuned default stays in force.
 */
import { delphiClient } from '../execution/delphiClient.js';
import { listCalibrationRows, getState, setState } from '../persistence/db.js';
import { logEvent } from '../observability/eventLog.js';

const MIN_GLOBAL_N = 12;
const MIN_CATEGORY_N = 15;
const EPS = 1e-4;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const logit = (p: number) => Math.log(clamp(p, EPS, 1 - EPS) / (1 - clamp(p, EPS, 1 - EPS)));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export interface LearnedWeights {
    global: number | null;
    byCategory: Record<string, number>;
    samples: number;
    fittedAt: number;
}

interface Sample { raw: number; market: number; y: number; category: string }

function fitWeight(samples: Sample[]): { w: number; loss: number } {
    let best = { w: 0.12, loss: Infinity };
    for (let w = 0; w <= 0.95001; w += 0.05) {
        let loss = 0;
        for (const s of samples) {
            const p = clamp(sigmoid((1 - w) * logit(s.raw) + w * logit(s.market)), EPS, 1 - EPS);
            loss += -(s.y * Math.log(p) + (1 - s.y) * Math.log(1 - p));
        }
        loss /= samples.length;
        if (loss < best.loss) best = { w: Number(w.toFixed(2)), loss };
    }
    return best;
}

/** Fetch settlement labels and refit the blend weights. Safe to call often;
 *  does nothing new unless more markets have settled. */
export async function selfCalibrate(): Promise<void> {
    try {
        const rows = await listCalibrationRows();
        if (rows.length === 0) return;

        const samples: Sample[] = [];
        for (const r of rows) {
            try {
                const m = await delphiClient.getMarket({ id: r.market_address });
                if (m.status !== 'settled' || m.winningOutcomeIdx === null) continue;
                samples.push({
                    raw: r.raw_prob,
                    market: r.market_price,
                    y: Number(m.winningOutcomeIdx) === 0 ? 1 : 0,
                    category: r.category || 'unknown',
                });
            } catch { /* market outside competition scope — skip */ }
        }

        if (samples.length < MIN_GLOBAL_N) {
            console.log(`  [Calibrate] ${samples.length}/${MIN_GLOBAL_N} settled samples — using hand-tuned weights until enough data.`);
            return;
        }

        const globalFit = fitWeight(samples);

        // Baselines for the log: pure-us (w=0) and pure-market (w=1)
        const usLoss = fitWeightAt(samples, 0);
        const mktLoss = fitWeightAt(samples, 0.95);

        const byCategory: Record<string, number> = {};
        const cats = [...new Set(samples.map(s => s.category))];
        for (const c of cats) {
            const sub = samples.filter(s => s.category === c);
            if (sub.length >= MIN_CATEGORY_N) byCategory[c] = fitWeight(sub).w;
        }

        const learned: LearnedWeights = {
            global: globalFit.w,
            byCategory,
            samples: samples.length,
            fittedAt: Date.now(),
        };
        await setState('learnedConsensusWeights', JSON.stringify(learned));

        const msg = `Self-calibration on ${samples.length} settled markets: optimal market-weight ${globalFit.w} (loss ${globalFit.loss.toFixed(3)} vs pure-us ${usLoss.toFixed(3)}, pure-market ${mktLoss.toFixed(3)})` +
            (Object.keys(byCategory).length ? ` | per-category: ${JSON.stringify(byCategory)}` : '');
        console.log(`  [Calibrate] ${msg}`);
        logEvent('THINK', msg);
    } catch (e) {
        console.warn('  [Calibrate] failed:', (e as Error).message?.slice(0, 150));
    }
}

function fitWeightAt(samples: Sample[], w: number): number {
    let loss = 0;
    for (const s of samples) {
        const p = clamp(sigmoid((1 - w) * logit(s.raw) + w * logit(s.market)), EPS, 1 - EPS);
        loss += -(s.y * Math.log(p) + (1 - s.y) * Math.log(1 - p));
    }
    return loss / samples.length;
}

/** Read the learned weights (null if never fitted). */
export async function getLearnedWeights(): Promise<LearnedWeights | null> {
    const raw = await getState('learnedConsensusWeights');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}
