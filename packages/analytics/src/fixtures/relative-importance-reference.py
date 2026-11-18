# Generates relative-importance-reference.json: an independent NumPy computation of LMG/Shapley shares (all subsets) and
# Johnson relative weights, which stats/relativeImportance.test.ts must match to 1e-9.  Run from packages/analytics: python3 src/fixtures/relative-importance-reference.py
import numpy as np, json, itertools, math
rng = np.random.default_rng(7)
n = 300
z = rng.normal(size=n)
x1 = z + 0.5*rng.normal(size=n)
x2 = z + 0.5*rng.normal(size=n)          # strongly correlated with x1
x3 = rng.normal(size=n)
x4 = 0.3*x3 + rng.normal(size=n)
y = 1.0*x1 + 0.2*x2 + 0.6*x3 + 0.0*x4 + rng.normal(size=n)
X = np.column_stack([x1,x2,x3,x4]); p = 4
D = np.column_stack([y, X]); R = np.corrcoef(D, rowvar=False)
def r2(s):
    if not s: return 0.0
    s=list(s); Rxx=R[np.ix_([i+1 for i in s],[i+1 for i in s])]; rxy=R[[i+1 for i in s],0]
    return float(rxy @ np.linalg.solve(Rxx, rxy))
sh=[]
for j in range(p):
    tot=0
    others=[i for i in range(p) if i!=j]
    for k in range(p):
        for S in itertools.combinations(others,k):
            tot += math.factorial(k)*math.factorial(p-k-1)/math.factorial(p)*(r2(S+(j,))-r2(S))
    sh.append(tot)
Rxx=R[1:,1:]; rxy=R[1:,0]
vals,vecs=np.linalg.eigh(Rxx); half=vecs@np.diag(np.sqrt(vals))@vecs.T
beta=np.linalg.solve(half,rxy); jw=[(half[j,:]**2*beta**2).sum() for j in range(p)]
json.dump({"y":y.tolist(),"xs":[c.tolist() for c in X.T],"r2":r2(range(p)),"shapley":sh,"johnson":jw},open("src/fixtures/relative-importance-reference.json","w"))
print(r2(range(p)), sh, jw)
