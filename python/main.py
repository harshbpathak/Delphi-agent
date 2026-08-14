"""
Delphi ML Prediction Service — Flow-Drift Model (ML Option 3)

Learns short-horizon price drift from REAL on-chain order flow.

The agent's trade poller mirrors every competitor trade into
../articles.sqlite (competitor_trades). Each fill implies an execution price
(tokens/shares), so per market we can reconstruct an approximate price path
and generate thousands of labeled samples:

    features(now)  ->  does the price of outcome 0 rise over the next fills?

A small logistic regression (pure numpy — honest for this sample size) is
fitted at startup and refreshed every 6h. /predict then returns the current
implied probability nudged in the direction of predicted drift, with
confidence scaled by activity and model conviction. If the model or the data
is unavailable it falls back to the transparent flow heuristic.
"""

from fastapi import FastAPI
from pydantic import BaseModel
import numpy as np
import sqlite3
import threading
import time
import os
from typing import Optional
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("delphi-ml")

app = FastAPI(title="Delphi Flow-Drift Service")

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "articles.sqlite")

WINDOW = 12          # feature window: last N fills
HORIZON = 8          # label horizon: price move over next N fills
MIN_FILLS = 25       # markets with fewer usable fills are skipped for training
DRIFT_LABEL_PT = 0.01
REFRESH_SECS = 6 * 3600
MAX_ADJ = 0.10       # cap the drift adjustment at ±10 points

# ─── Data access ─────────────────────────────────────────────────────────────

def load_fills():
    """Rows -> per-market ordered list of (ts, implied p0, tokens, wallet)."""
    try:
        con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=3)
        rows = con.execute(
            "SELECT market, side, outcome_idx, tokens, shares, ts, wallet "
            "FROM competitor_trades WHERE side IN ('buy','sell') AND shares > 0 "
            "ORDER BY market, ts"
        ).fetchall()
        con.close()
    except Exception as e:
        logger.warning(f"DB read failed: {e}")
        return {}

    markets = {}
    for market, side, oi, tokens, shares, ts, wallet in rows:
        if not tokens or not shares or shares <= 0:
            continue
        p = tokens / shares
        if not (0.01 < p < 0.99):
            continue
        p0 = p if oi == 0 else 1.0 - p
        markets.setdefault(market, []).append((ts, p0, tokens, wallet, side, oi))
    return markets

# ─── Feature engineering ─────────────────────────────────────────────────────

def features_at(fills, i):
    """Feature vector from fills[i-WINDOW:i] with current price fills[i-1]."""
    win = fills[i - WINDOW:i]
    p_now = win[-1][1]
    p_prev = win[0][1]

    up_vol = sum(t for (_, _, t, _, s, oi) in win if (s == 'buy' and oi == 0) or (s == 'sell' and oi == 1))
    dn_vol = sum(t for (_, _, t, _, s, oi) in win if (s == 'buy' and oi == 1) or (s == 'sell' and oi == 0))
    tot = up_vol + dn_vol
    imbalance = (up_vol - dn_vol) / tot if tot > 0 else 0.0

    wallets = len({w for (_, _, _, w, _, _) in win})
    span_h = max(0.01, (win[-1][0] - win[0][0]) / 3600)

    return np.array([
        imbalance,                    # who is pushing
        p_now - p_prev,               # recent momentum
        np.log1p(tot) / 10.0,         # volume scale
        wallets / 10.0,               # breadth
        p_now - 0.5,                  # price location
        np.log1p(1.0 / span_h),       # trade intensity
        1.0,                          # bias
    ])

def build_dataset(markets):
    X, y = [], []
    for fills in markets.values():
        if len(fills) < MIN_FILLS:
            continue
        for i in range(WINDOW, len(fills) - HORIZON):
            p_now = fills[i - 1][1]
            p_fut = float(np.median([f[1] for f in fills[i:i + HORIZON]]))
            X.append(features_at(fills, i))
            y.append(1.0 if (p_fut - p_now) > DRIFT_LABEL_PT else 0.0)
    return (np.array(X), np.array(y)) if X else (None, None)

# ─── Model ───────────────────────────────────────────────────────────────────

class DriftModel:
    def __init__(self):
        self.w = None
        self.mu = None
        self.sd = None
        self.n_train = 0
        self.acc = 0.0
        self.lock = threading.Lock()

    def fit(self):
        markets = load_fills()
        X, y = build_dataset(markets)
        if X is None or len(y) < 300 or len(set(y)) < 2:
            logger.warning(f"Drift model: insufficient data ({0 if y is None else len(y)} samples) — heuristic fallback stays active.")
            return
        mu, sd = X.mean(0), X.std(0) + 1e-6
        mu[-1], sd[-1] = 0.0, 1.0  # leave bias untouched
        Xn = (X - mu) / sd
        w = np.zeros(X.shape[1])
        for _ in range(400):  # plain gradient descent on log-loss
            p = 1 / (1 + np.exp(-Xn @ w))
            w -= 0.5 * (Xn.T @ (p - y)) / len(y)
        p = 1 / (1 + np.exp(-Xn @ w))
        acc = float(((p > 0.5) == (y > 0.5)).mean())
        base = float(max(y.mean(), 1 - y.mean()))
        with self.lock:
            self.w, self.mu, self.sd, self.n_train, self.acc = w, mu, sd, len(y), acc
        logger.info(f"Drift model fitted: {len(y)} samples from {sum(1 for f in markets.values() if len(f) >= MIN_FILLS)} markets | train acc {acc:.3f} (majority baseline {base:.3f})")

    def predict_up(self, feats):
        with self.lock:
            if self.w is None:
                return None
            z = (feats - self.mu) / self.sd
            return float(1 / (1 + np.exp(-(z @ self.w))))

MODEL = DriftModel()

def refresher():
    while True:
        try:
            MODEL.fit()
        except Exception as e:
            logger.warning(f"Drift model refresh failed: {e}")
        time.sleep(REFRESH_SECS)

threading.Thread(target=refresher, daemon=True).start()

# ─── API ─────────────────────────────────────────────────────────────────────

class PredictionRequest(BaseModel):
    market_address: str
    current_implied_prob: float
    question: str
    headlines: Optional[list[str]] = None

class PredictionResponse(BaseModel):
    probability: float
    confidence: float
    features_used: dict
    method: str

def market_fills(addr):
    try:
        con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=3)
        rows = con.execute(
            "SELECT ts, side, outcome_idx, tokens, shares, wallet FROM competitor_trades "
            "WHERE market = ? AND side IN ('buy','sell') AND shares > 0 ORDER BY ts",
            (addr.lower(),)
        ).fetchall()
        con.close()
    except Exception:
        return []
    out = []
    for ts, side, oi, tokens, shares, wallet in rows:
        if not tokens or not shares or shares <= 0:
            continue
        p = tokens / shares
        if not (0.01 < p < 0.99):
            continue
        out.append((ts, p if oi == 0 else 1 - p, tokens, wallet, side, oi))
    return out

@app.post("/predict", response_model=PredictionResponse)
def predict_probability(req: PredictionRequest):
    anchor = req.current_implied_prob
    fills = market_fills(req.market_address)

    if len(fills) >= WINDOW:
        p_up = MODEL.predict_up(features_at(fills, len(fills)))
        if p_up is not None:
            drift = 2 * p_up - 1                       # [-1, 1]
            recent = [f for f in fills if f[0] > time.time() - 86400]
            activity = min(len(recent) / 50.0, 1.0)
            prob = float(np.clip(anchor + MAX_ADJ * drift * activity, 0.02, 0.98))
            conf = float(np.clip(0.35 * activity * abs(drift), 0.0, 0.35))
            return PredictionResponse(
                probability=prob,
                confidence=conf,
                features_used={"p_up": round(p_up, 3), "activity": round(activity, 2),
                               "fills": len(fills), "model_n": MODEL.n_train, "model_acc": round(MODEL.acc, 3)},
                method="flow_drift_lr",
            )

    # Fallback: transparent flow heuristic on whatever data exists.
    if not fills:
        return PredictionResponse(
            probability=anchor, confidence=0.0,
            features_used={"note": "no mirrored fills for this market"},
            method="no_data_passthrough",
        )
    win = fills[-WINDOW:]
    up = sum(t for (_, _, t, _, s, oi) in win if (s == 'buy' and oi == 0) or (s == 'sell' and oi == 1))
    dn = sum(t for (_, _, t, _, s, oi) in win if (s == 'buy' and oi == 1) or (s == 'sell' and oi == 0))
    tot = up + dn
    lean = (up - dn) / tot if tot > 0 else 0.0
    prob = float(np.clip(anchor + 0.06 * lean, 0.02, 0.98))
    return PredictionResponse(
        probability=prob, confidence=0.15,
        features_used={"lean": round(lean, 3), "fills": len(fills)},
        method="flow_heuristic_v3",
    )

@app.get("/health")
def health():
    return {"status": "ok", "service": "delphi-flow-drift",
            "model_fitted": MODEL.w is not None, "train_samples": MODEL.n_train,
            "train_acc": round(MODEL.acc, 3)}
