import { DEFAULT_GUARDRAILS } from './kellyCalculator.js';
/**
 * Gap-aware, calibration-gated, endgame-aware risk posture.
 *
 * Ranking is PnL, the prize is TOP THREE, so the objective is expected RANK,
 * not expected wealth:
 *  - Behind → tolerate more EV-positive variance (higher fractional Kelly).
 *  - Podium → protect (lower Kelly).
 *  - PROVEN calibration (≥20 closed positions, profitable, ≥55% win rate)
 *    unlocks a higher Kelly: same decision quality, bigger extraction.
 *  - FINAL 48 HOURS (set COMPETITION_END in .env, ISO date): if just below
 *    #3, concentrate; if holding a podium spot, freeze into protection.
 *
 * The minimum-edge threshold, category exposure cap and circuit breaker are
 * NEVER relaxed by this module.
 */
const KELLY_MIN = 0.12;
const KELLY_MAX = 0.50;
const PROVEN_MIN_SETTLED = 20;
const PROVEN_MIN_WINRATE = 0.55;
export function postureAdjustedGuardrails(posture, bankroll, perf) {
    let kelly = DEFAULT_GUARDRAILS.fractionalKelly; // 0.25
    let maxBet = DEFAULT_GUARDRAILS.maxSingleBetPct;
    if (posture.ourRank !== null) {
        if (posture.ourRank <= 3) {
            kelly = 0.20; // protect a podium position
        }
        else if (posture.gapToLeader > bankroll * 0.5) {
            kelly = 0.35; // far behind: EV-positive variance is our friend
        }
        else if (posture.gapToLeader > bankroll * 0.2) {
            kelly = 0.30;
        }
    }
    // Calibration gate: once the journal PROVES the edge is real, size up.
    const proven = perf.settled >= PROVEN_MIN_SETTLED && perf.netPnl > 0 && perf.winRate >= PROVEN_MIN_WINRATE;
    if (proven && posture.ourRank !== null && posture.ourRank > 3) {
        kelly = Math.max(kelly, 0.40);
    }
    // Endgame: optimize expected rank, not expected PnL.
    const endIso = process.env.COMPETITION_END;
    const endTs = endIso ? Date.parse(endIso) : NaN;
    if (!isNaN(endTs)) {
        const hoursLeft = (endTs - Date.now()) / 3600_000;
        if (hoursLeft > 0 && hoursLeft <= 48 && posture.ourRank !== null) {
            if (posture.ourRank <= 3) {
                // Holding a prize spot: variance only hurts now.
                kelly = 0.12;
                maxBet = 0.05;
            }
            else if (posture.gapToThird > 0 && posture.gapToThird <= bankroll * 0.8) {
                // Within striking distance of the money: concentrate.
                kelly = 0.50;
                maxBet = 0.15;
            }
        }
    }
    return {
        ...DEFAULT_GUARDRAILS,
        fractionalKelly: Math.min(KELLY_MAX, Math.max(KELLY_MIN, kelly)),
        maxSingleBetPct: maxBet,
    };
}
