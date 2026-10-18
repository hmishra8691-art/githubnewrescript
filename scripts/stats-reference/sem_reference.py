"""
Reference results for the SEM estimator in packages/analytics/src/models/sem.ts.

Three models, each fitted with semopy 2.3 (objective MLW, expected information),
solver trust-constr, with lavaan-convention fit statistics recomputed in numpy from semopy's implied
covariance matrix (chi2 = N * F_ML, RMSEA with N, SRMR Bentler, AIC/BIC from the
full normal log-likelihood):

  1. Holzinger & Swineford (1939) 3-factor CFA, N = 301 (semopy.examples.holzinger39)
     - also checked against the published lavaan values (lavaan tutorial).
  2. Bollen's Political Democracy model, N = 75 (semopy.examples.political_democracy):
     3 factors, 2 structural paths, 6 residual covariances.
  3. A simulated structural model with mediation (seeded numpy):
     X =~ x1..x3, M =~ m1..m3, Y =~ y1..y3; M ~ a*X; Y ~ c*X + b*M; ind := a*b.

Writes fixtures/sem.json (data + estimates + SEs + fit), read by the TS tests.

    python3 scripts/stats-reference/sem_reference.py

Validation only - Python is not used in production.
"""
import json
import os
import numpy as np
import semopy
from semopy.examples import holzinger39, political_democracy

HERE = os.path.dirname(os.path.abspath(__file__))


def lavaan_fit(model, data, observed, npar):
    X = data[observed].to_numpy(float)
    N, p = X.shape
    S = np.cov(X, rowvar=False, bias=True)
    sigma, _ = model.calc_sigma()
    # semopy orders observed variables in model.vars['observed']
    order = [model.vars["observed"].index(v) for v in observed]
    sigma = sigma[np.ix_(order, order)]
    sinv = np.linalg.inv(sigma)
    F = np.linalg.slogdet(sigma)[1] + np.trace(S @ sinv) - np.linalg.slogdet(S)[1] - p
    chisq = N * F
    moments = p * (p + 1) / 2
    df = moments - npar
    base = N * (np.sum(np.log(np.diag(S))) - np.linalg.slogdet(S)[1])
    dfb = moments - p
    cfi = 1 - max(chisq - df, 0) / max(base - dfb, chisq - df, 0)
    tli = (base / dfb - chisq / df) / (base / dfb - 1)
    rmsea = np.sqrt(max(chisq - df, 0) / (df * N))
    d = np.sqrt(np.diag(S))
    R = (S - sigma) / np.outer(d, d)
    srmr = np.sqrt(np.sum(np.tril(R) ** 2) / moments)
    ll = -0.5 * N * (p * np.log(2 * np.pi) + np.linalg.slogdet(sigma)[1] + np.trace(S @ sinv))
    return {"n": int(N), "npar": int(npar), "chisq": float(chisq), "df": int(df), "baselineChisq": float(base), "baselineDf": int(dfb),
            "cfi": float(cfi), "tli": float(tli), "rmsea": float(rmsea), "srmr": float(srmr), "logLik": float(ll),
            "aic": float(-2 * ll + 2 * npar), "bic": float(-2 * ll + npar * np.log(N))}


def fit(desc, data, observed):
    m = semopy.Model(desc)
    # trust-constr converges to the optimum to ~1e-10 in F (SLSQP, the default, stops ~1e-6 short)
    m.fit(data, obj="MLW", solver="trust-constr")
    ins = m.inspect(information="expected")
    std = m.inspect(std_est=True, information="expected")
    est = []
    for (_, r), (_, s) in zip(ins.iterrows(), std.iterrows()):
        se = r["Std. Err"]
        est.append({"lval": r["lval"], "op": r["op"], "rval": r["rval"], "est": float(r["Estimate"]),  # semopy writes loadings as "x1 ~ visual"
                    "se": None if se == "-" else float(se), "std": float(s["Est. Std"])})
    npar = len(m.param_vals)
    stats = semopy.calc_stats(m).T.iloc[:, 0].to_dict()
    return est, lavaan_fit(m, data, observed, npar), {k: float(v) for k, v in stats.items()}


out = {}

# 1. Holzinger-Swineford
hs = holzinger39.get_data()
obs_hs = [f"x{i}" for i in range(1, 10)]
desc_hs = "visual =~ x1 + x2 + x3\ntextual =~ x4 + x5 + x6\nspeed =~ x7 + x8 + x9"
e, f, s = fit(desc_hs, hs, obs_hs)
out["hs"] = {"syntax": desc_hs, "data": {v: hs[v].astype(float).tolist() for v in obs_hs}, "estimates": e, "fit": f, "semopyStats": s,
             "lavaanPublished": {"chisq": 85.306, "df": 24, "cfi": 0.931, "tli": 0.896, "rmsea": 0.092, "rmseaLow": 0.071, "rmseaHigh": 0.114, "srmr": 0.065, "aic": 7517.490, "bic": 7595.339,
                                 "loadings": {"x2": [0.554, 0.100], "x3": [0.729, 0.109], "x5": [1.113, 0.065], "x6": [0.926, 0.055], "x8": [1.180, 0.165], "x9": [1.082, 0.151]}}}
print("HS", f)

# 2. Political democracy
pdd = political_democracy.get_data()
obs_pd = ["x1", "x2", "x3", "y1", "y2", "y3", "y4", "y5", "y6", "y7", "y8"]
desc_pd = political_democracy.get_model()
e, f, s = fit(desc_pd, pdd, obs_pd)
out["poldem"] = {"syntax": desc_pd, "data": {v: pdd[v].astype(float).tolist() for v in obs_pd}, "estimates": e, "fit": f, "semopyStats": s,
                 "lavaanPublished": {"chisq": 38.125, "df": 35}}
print("PD", f)

# 3. Simulated mediation
rng = np.random.default_rng(42)
N = 500
X = rng.normal(size=N)
M = 0.5 * X + rng.normal(scale=np.sqrt(1 - 0.25), size=N)
Y = 0.2 * X + 0.4 * M + rng.normal(scale=0.8, size=N)
cols = {}
for name, lat, lams in (("x", X, [1.0, 0.8, 1.2]), ("m", M, [1.0, 0.9, 0.7]), ("y", Y, [1.0, 1.1, 0.8])):
    for i, l in enumerate(lams):
        cols[f"{name}{i + 1}"] = (l * lat + rng.normal(scale=0.6, size=N)).tolist()
import pandas as pd
sim = pd.DataFrame(cols)
desc_sim = "X =~ x1 + x2 + x3\nM =~ m1 + m2 + m3\nY =~ y1 + y2 + y3\nM ~ a*X\nY ~ c*X + b*M"
e, f, s = fit(desc_sim, sim, list(cols))
# delta-method indirect effect from semopy's estimates and covariance
a = next(x for x in e if x["lval"] == "M" and x["rval"] == "X" and x["op"] == "~")
b = next(x for x in e if x["lval"] == "Y" and x["rval"] == "M" and x["op"] == "~")
ind = a["est"] * b["est"]
# Sobel/delta SE ignoring the a-b covariance (they are ~uncorrelated in this recursive model); TS computes the full delta method
sobel = float(np.sqrt(b["est"] ** 2 * a["se"] ** 2 + a["est"] ** 2 * b["se"] ** 2))
out["mediation"] = {"syntax": desc_sim + "\nind := a*b", "data": cols, "estimates": e, "fit": f, "semopyStats": s,
                    "truth": {"a": 0.5, "b": 0.4, "c": 0.2, "indirect": 0.2},
                    "indirect": {"est": ind, "sobelSe": sobel}}
print("SIM", f, "indirect", ind, sobel)

with open(os.path.join(HERE, "fixtures", "sem.json"), "w") as fh:
    json.dump(out, fh)
print("wrote fixtures/sem.json")
