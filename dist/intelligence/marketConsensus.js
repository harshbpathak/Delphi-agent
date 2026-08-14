/**
 * Market-consensus dampener.
 *
 * The market price is not just a number to beat — it is the aggregated
 * estimate of ~90 competing agents, most of them LLM-driven with search.
 * When our estimate disagrees violently with that aggregate, the base rate
 * says WE are wrong far more often than the crowd is.
 *
 * This module shrinks our raw estimate toward the market price in log-odds
 * space. The weight placed on the market rises with:
 *   - the SIZE of the disagreement (extreme deviations need extreme evidence)
 *   - TIME PRESSURE (near the deadline the crowd has seen all public info;
 *     a late, huge disagreement is usually our misreading, not their blindness)
 *   - MARKET DEPTH (more independent traders = stronger aggregation)
 *   - CRITERIA AMBIGUITY (if the rules admit two readings, the risk is our
 *     interpretation, and no amount of fact-checking resolves it)
 *
 * ...and falls only for a genuinely VERIFIED DETERMINISTIC FACT: the event
 * has concluded, the criteria are unambiguous, and we can name the specific
 * public fact the market appears to have missed. That is the one situation
 * where overriding 89 other agents is justified.
 *
 * Lesson encoded here (the "Astra" case): a verified fact does NOT license
 * overconfidence when the criteria themselves are ambiguous. There, the facts
 * were never in doubt — the mapping from fact to outcome was.
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const EPS = 1e-4;
const logit = (p) => Math.log(clamp(p, EPS, 1 - EPS) / (1 - clamp(p, EPS, 1 - EPS)));
const invLogit = (x) => 1 / (1 + Math.exp(-x));
export function applyMarketConsensus(input) {
    const { rawProb, marketProb, hoursToResolve, trades24h, uniqueWallets24h, eventConcluded, ambiguity, hasJustification } = input;
    // The narrow licence to override the crowd: settled facts AND clean rules
    // AND a named reason. Ambiguous criteria void it — that is precisely the
    // case where being right about the facts does not make us right about the
    // outcome.
    const verifiedFact = eventConcluded && ambiguity === 'none' && hasJustification;
    let w = 0.20; // always give the aggregate some respect
    // 1. Size of disagreement
    const disagreement = Math.abs(rawProb - marketProb);
    if (disagreement > 0.50)
        w += 0.30;
    else if (disagreement > 0.30)
        w += 0.20;
    else if (disagreement > 0.15)
        w += 0.10;
    // 2. Time pressure — the crowd has had maximum opportunity to be right,
    //    and little time remains for our thesis to be vindicated by events.
    if (hoursToResolve !== null) {
        if (hoursToResolve < 6)
            w += 0.25;
        else if (hoursToResolve < 24)
            w += 0.15;
        else if (hoursToResolve < 72)
            w += 0.05;
    }
    // 3. Depth of aggregation
    if (uniqueWallets24h >= 10)
        w += 0.15;
    else if (uniqueWallets24h >= 5)
        w += 0.08;
    if (trades24h < 5)
        w -= 0.10; // a near-empty book is weak evidence
    // 4. Ambiguous rules: our reading is the risk, not the facts
    if (ambiguity === 'severe')
        w += 0.30;
    else if (ambiguity === 'minor')
        w += 0.12;
    // 5. The one legitimate override
    if (verifiedFact)
        w -= 0.45;
    w = clamp(w, 0.05, 0.90);
    let p = invLogit((1 - w) * logit(rawProb) + w * logit(marketProb));
    // Hard deviation ceiling — a floor under humility that blending can't undo.
    const cap = verifiedFact ? 0.85 : ambiguity === 'severe' ? 0.12 : 0.35;
    let capped = false;
    if (Math.abs(p - marketProb) > cap) {
        p = marketProb + Math.sign(p - marketProb) * cap;
        capped = true;
    }
    const note = verifiedFact
        ? `verified fact — market weight ${w.toFixed(2)}`
        : `raw ${(rawProb * 100).toFixed(0)}% vs market ${(marketProb * 100).toFixed(0)}% → ${(p * 100).toFixed(0)}% (market weight ${w.toFixed(2)}, ambiguity ${ambiguity}${capped ? ', DEVIATION CAPPED' : ''})`;
    return { probability: clamp(p, 0.01, 0.99), weightOnMarket: w, verifiedFact, capped, note };
}
