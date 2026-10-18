"""
Reference results for the latent class analysis in packages/analytics/src/models/lca.ts.

Simulates N respondents from a KNOWN 3-class model over 6 categorical indicators
(4 binary, 2 with three categories), then fits K = 1..4 with
  (a) stepmix 3.0 (measurement="categorical", 30 random starts), and
  (b) an independent hand-written EM in numpy (50 random starts),
and writes data + truth + both references to fixtures/lca.json, which the TS
tests read (CI never needs Python).

    python3 scripts/stats-reference/lca_reference.py

Validation only - Python is not used in production.
"""
import json
import os
import numpy as np
from stepmix.stepmix import StepMix

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(20261018)

N = 1200
CATS = [2, 2, 2, 2, 3, 3]
PI = np.array([0.5, 0.3, 0.2])
# rho[k][j] = category probabilities
RHO = [
    [[0.9, 0.1], [0.85, 0.15], [0.8, 0.2], [0.9, 0.1], [0.7, 0.2, 0.1], [0.6, 0.3, 0.1]],
    [[0.2, 0.8], [0.25, 0.75], [0.7, 0.3], [0.3, 0.7], [0.1, 0.3, 0.6], [0.2, 0.6, 0.2]],
    [[0.15, 0.85], [0.8, 0.2], [0.1, 0.9], [0.85, 0.15], [0.2, 0.6, 0.2], [0.1, 0.1, 0.8]],
]
cls = rng.choice(3, size=N, p=PI)
X = np.zeros((N, len(CATS)), dtype=int)
for i in range(N):
    for j, r in enumerate(CATS):
        X[i, j] = rng.choice(r, p=RHO[cls[i]][j])


def numpy_em(X, cats, K, starts, seed, max_iter=5000, tol=1e-10):
    g = np.random.default_rng(seed)
    n, J = X.shape
    onehots = [np.eye(r)[X[:, j]] for j, r in enumerate(cats)]  # n x r
    best = None
    lls = []
    for _ in range(starts):
        pi = np.full(K, 1.0 / K)
        rho = [g.dirichlet(np.ones(r), size=K) for r in cats]  # list J of K x r
        ll_old = -np.inf
        for it in range(max_iter):
            logp = np.log(pi)[None, :].repeat(n, 0)
            for j in range(J):
                logp = logp + onehots[j] @ np.log(np.maximum(rho[j], 1e-300)).T
            mx = logp.max(1, keepdims=True)
            p = np.exp(logp - mx)
            Z = p.sum(1, keepdims=True)
            post = p / Z
            ll = float((mx[:, 0] + np.log(Z[:, 0])).sum())
            if abs(ll - ll_old) < tol:
                break
            ll_old = ll
            nk = post.sum(0)
            pi = nk / n
            rho = [np.maximum((post.T @ onehots[j]) / nk[:, None], 1e-12) for j in range(J)]
            rho = [r / r.sum(1, keepdims=True) for r in rho]
        lls.append(ll)
        if best is None or ll > best[0]:
            best = (ll, pi.copy(), [r.copy() for r in rho])
    ll, pi, rho = best
    order = np.argsort(-pi)
    return ll, pi[order].tolist(), [[rho[j][k].tolist() for j in range(J)] for k in order], int(sum(abs(v - ll) < 0.01 for v in lls))


out = {
    "description": "3-class model, 6 indicators (4 binary, 2 three-category), N=1200; seed 20261018",
    "categories": CATS,
    "data": X.tolist(),
    "true": {"classSizes": PI.tolist(), "itemProbs": RHO, "class": cls.tolist()},
    "stepmix": {},
    "numpy": {},
}
for K in range(1, 5):
    m = StepMix(n_components=K, measurement="categorical", n_init=30, random_state=7, max_iter=5000, abs_tol=1e-10, verbose=0, progress_bar=0)
    m.fit(X)
    ll = float(m.score(X) * N)
    params = m.get_parameters()
    w = np.array(params["weights"])
    pis = np.array(params["measurement"]["pis"])  # K x (J * maxcat)
    maxc = max(CATS)
    order = np.argsort(-w)
    items = [[pis[k].reshape(len(CATS), maxc)[j, : CATS[j]].tolist() for j in range(len(CATS))] for k in order]
    npar = (K - 1) + K * sum(r - 1 for r in CATS)
    out["stepmix"][str(K)] = {
        "logLik": ll, "npar": npar,
        "aic": -2 * ll + 2 * npar, "bic": -2 * ll + npar * np.log(N),
        "stepmixBic": float(m.bic(X)), "stepmixAic": float(m.aic(X)),
        "classSizes": w[order].tolist(), "itemProbs": items,
    }
    ll2, pi2, rho2, rep = numpy_em(X, CATS, K, 50, 100 + K)
    out["numpy"][str(K)] = {"logLik": ll2, "classSizes": pi2, "itemProbs": rho2, "replicated": rep}
    print(K, "stepmix LL", round(ll, 4), "numpy LL", round(ll2, 4), "stepmix BIC", round(float(m.bic(X)), 3), "ours-formula BIC", round(-2 * ll + npar * np.log(N), 3))

with open(os.path.join(HERE, "fixtures", "lca.json"), "w") as f:
    json.dump(out, f)
print("wrote fixtures/lca.json")
