"""
Reference results for the bootstrap of an indirect effect (packages/analytics/src/stats/bootstrap.ts).

Data: the simulated X -> M -> Y mediation dataset already committed in fixtures/sem.json (N = 500,
three indicators per construct); X, M and Y are the means of their three indicators.

The bootstrap is re-done here INDEPENDENTLY of the TypeScript code except for the random stream:
  * the resamples come from the same seeded generator (mulberry32, as packages/analytics/src/models/rng.ts:
    index = floor(u * n), n draws per resample) re-implemented below in Python, so both sides resample
    exactly the same respondents;
  * each replicate's a (M on X) and b (Y on M controlling X) come from numpy least squares on the
    resampled rows;
  * the percentile interval is numpy's linear (type 7) percentile; the BCa interval follows Efron &
    Tibshirani (1993, eq. 14.9-14.15) with scipy.stats.norm for Phi and Phi^-1, z0 from the share of
    replicates strictly below the estimate, the acceleration from the leave-one-out jackknife.

As a second, looser check the script also runs scipy.stats.bootstrap (method="BCa", its own random
stream, 9,999 resamples): it must agree with ours within Monte-Carlo error (the TS test allows 0.01).

    python3 scripts/stats-reference/bootstrap_reference.py

Validation only - Python is not used in production.
"""
import json
import os
import numpy as np
from scipy import stats

HERE = os.path.dirname(os.path.abspath(__file__))
MASK = 0xFFFFFFFF


class Mulberry32:
    """the Rng of packages/analytics/src/models/rng.ts (uniform part only)"""

    def __init__(self, seed):
        self.s = ((seed & MASK) ^ 0x9E3779B9) & MASK

    def next(self):
        self.s = (self.s + 0x6D2B79F5) & MASK
        s = self.s
        t = ((s ^ (s >> 15)) * (1 | s)) & MASK
        t = (((t + (((t ^ (t >> 7)) * (61 | t)) & MASK)) & MASK) ^ t) & MASK
        return ((t ^ (t >> 14)) & MASK) / 4294967296.0


def indirect(x, m, y):
    one = np.ones_like(x)
    a = np.linalg.lstsq(np.column_stack([one, x]), m, rcond=None)[0][1]
    b = np.linalg.lstsq(np.column_stack([one, x, m]), y, rcond=None)[0][2]
    return a, b, a * b


def main():
    with open(os.path.join(HERE, "fixtures", "sem.json")) as f:
        d = json.load(f)["mediation"]["data"]
    X = np.mean([d["x1"], d["x2"], d["x3"]], axis=0)
    M = np.mean([d["m1"], d["m2"], d["m3"]], axis=0)
    Y = np.mean([d["y1"], d["y2"], d["y3"]], axis=0)
    n = len(X)
    seed, draws, level = 7, 2000, 0.95
    a, b, est = indirect(X, M, Y)

    rng = Mulberry32(seed)
    reps = np.empty(draws)
    for r in range(draws):
        idx = np.array([int(rng.next() * n) for _ in range(n)])
        reps[r] = indirect(X[idx], M[idx], Y[idx])[2]
    alpha = (1 - level) / 2
    perc = [float(np.percentile(reps, 100 * alpha, method="linear")), float(np.percentile(reps, 100 * (1 - alpha), method="linear"))]

    z0 = stats.norm.ppf(np.mean(reps < est))
    jack = np.array([indirect(np.delete(X, i), np.delete(M, i), np.delete(Y, i))[2] for i in range(n)])
    jm = jack.mean()
    acc = np.sum((jm - jack) ** 3) / (6 * np.sum((jm - jack) ** 2) ** 1.5)

    def adj(z):
        return stats.norm.cdf(z0 + (z0 + z) / (1 - acc * (z0 + z)))

    lo_q, hi_q = adj(stats.norm.ppf(alpha)), adj(stats.norm.ppf(1 - alpha))
    bca = [float(np.percentile(reps, 100 * lo_q, method="linear")), float(np.percentile(reps, 100 * hi_q, method="linear"))]

    sp = stats.bootstrap((X, M, Y), lambda x, m, y: indirect(x, m, y)[2], paired=True, vectorized=False, n_resamples=9999,
                         confidence_level=level, method="BCa", random_state=np.random.default_rng(1))
    out = {
        "seed": seed, "draws": draws, "level": level, "n": n,
        "data": {"x": X.tolist(), "m": M.tolist(), "y": Y.tolist()},
        "a": float(a), "b": float(b), "indirect": float(est),
        "se": float(reps.std(ddof=1)), "bias": float(reps.mean() - est),
        "percentile": perc, "bca": bca, "z0": float(z0), "acceleration": float(acc),
        "first_replicates": reps[:5].tolist(),
        "scipy_bca_9999": [float(sp.confidence_interval.low), float(sp.confidence_interval.high)],
    }
    with open(os.path.join(HERE, "fixtures", "bootstrap.json"), "w") as f:
        json.dump(out, f)
    print(json.dumps({k: v for k, v in out.items() if k != "data"}, indent=1))


if __name__ == "__main__":
    main()
