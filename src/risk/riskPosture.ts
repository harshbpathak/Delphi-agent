import { RiskGuardrails, DEFAULT_GUARDRAILS } from './kellyCalculator.js';
import { CompetitionPosture } from '../intelligence/marketContext.js';

/**
 * Gap-aware risk posture.
 *
 * Ranking is PnL, so the competition is a race, not an absolute-return
 * exercise. Behind the leader → tolerate slightly more variance (higher
 * fractional Kelly). Near the top → protect the position. All adjustments
 * stay inside hard bounds; the 5% single-trade cap, minimum-edge threshold
 * and circuit breaker are NEVER relaxed.
 */

const KELLY_MIN = 0.15;
const KELLY_MAX = 0.35;

export function postureAdjustedGuardrails(posture: CompetitionPosture, bankroll: number): RiskGuardrails {
    let kelly = DEFAULT_GUARDRAILS.fractionalKelly;

    if (posture.ourRank !== null) {
        if (posture.ourRank <= 3) {
            kelly = 0.20; // protect a podium position
        } else if (posture.gapToLeader > bankroll * 0.5) {
            kelly = 0.35; // far behind: EV-positive variance is our friend
        } else if (posture.gapToLeader > bankroll * 0.2) {
            kelly = 0.30;
        }
    }

    return {
        ...DEFAULT_GUARDRAILS,
        fractionalKelly: Math.min(KELLY_MAX, Math.max(KELLY_MIN, kelly)),
    };
}
