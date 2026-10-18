/**
 * Dense linear algebra on flat row-major Float64Arrays / number arrays, for
 * the model estimators (HB covariance draws, SEM implied covariances). Small
 * matrices (p ≤ ~60), so plain O(n³) routines; everything deterministic.
 */

/** lower Cholesky factor of a symmetric positive-definite n×n matrix (flat, row-major); null when not positive definite */
export function cholesky(a: ArrayLike<number>, n: number): Float64Array | null {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (!(s > 0) || !Number.isFinite(s)) return null;
        L[i * n + i] = Math.sqrt(s);
      } else L[i * n + j] = s / L[j * n + j];
    }
  }
  return L;
}

/** solve L y = b (forward substitution), L lower triangular */
export function forwardSolve(L: ArrayLike<number>, n: number, b: ArrayLike<number>): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
  return y;
}

/** solve L' x = y (back substitution) */
export function backSolveT(L: ArrayLike<number>, n: number, y: ArrayLike<number>): Float64Array {
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}

/** inverse of an SPD matrix from its Cholesky factor */
export function cholInverse(L: ArrayLike<number>, n: number): Float64Array {
  const inv = new Float64Array(n * n);
  const e = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    e.fill(0); e[j] = 1;
    const x = backSolveT(L, n, forwardSolve(L, n, e));
    for (let i = 0; i < n; i++) inv[i * n + j] = x[i];
  }
  return inv;
}

export const logDetFromChol = (L: ArrayLike<number>, n: number): number => { let s = 0; for (let i = 0; i < n; i++) s += Math.log(L[i * n + i]); return 2 * s; };

/** C = A B for flat matrices (A: r×k, B: k×c) */
export function matMul(A: ArrayLike<number>, B: ArrayLike<number>, r: number, k: number, c: number): Float64Array {
  const C = new Float64Array(r * c);
  for (let i = 0; i < r; i++) for (let t = 0; t < k; t++) { const a = A[i * k + t]; if (a === 0) continue; for (let j = 0; j < c; j++) C[i * c + j] += a * B[t * c + j]; }
  return C;
}

/** general inverse by Gauss–Jordan with partial pivoting (flat n×n); null when singular */
export function invert(a: ArrayLike<number>, n: number, tol = 1e-13): Float64Array | null {
  const m = new Float64Array(n * 2 * n);
  let scale = 0;
  for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) { m[i * 2 * n + j] = a[i * n + j]; scale = Math.max(scale, Math.abs(a[i * n + j])); } m[i * 2 * n + n + i] = 1; }
  const eps = tol * Math.max(scale, 1e-300);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r * 2 * n + col]) > Math.abs(m[piv * 2 * n + col])) piv = r;
    if (Math.abs(m[piv * 2 * n + col]) <= eps) return null;
    if (piv !== col) for (let j = 0; j < 2 * n; j++) { const t = m[col * 2 * n + j]; m[col * 2 * n + j] = m[piv * 2 * n + j]; m[piv * 2 * n + j] = t; }
    const d = m[col * 2 * n + col];
    for (let j = 0; j < 2 * n; j++) m[col * 2 * n + j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r * 2 * n + col]; if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) m[r * 2 * n + j] -= f * m[col * 2 * n + j];
    }
  }
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i * n + j] = m[i * 2 * n + n + j];
  return out;
}

/** smallest eigenvalue of a symmetric matrix by Jacobi sweeps (diagnostics only — e.g. is the information matrix singular?) */
export function minEigenSym(a: ArrayLike<number>, n: number): number {
  const m = Float64Array.from(a as ArrayLike<number>);
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += m[i * n + j] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = m[p * n + q]; if (Math.abs(apq) < 1e-300) continue;
      const th = (m[q * n + q] - m[p * n + p]) / (2 * apq);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const kp = m[k * n + p], kq = m[k * n + q]; m[k * n + p] = c * kp - s * kq; m[k * n + q] = s * kp + c * kq; }
      for (let k = 0; k < n; k++) { const pk = m[p * n + k], qk = m[q * n + k]; m[p * n + k] = c * pk - s * qk; m[q * n + k] = s * pk + c * qk; }
    }
  }
  let mn = Infinity;
  for (let i = 0; i < n; i++) mn = Math.min(mn, m[i * n + i]);
  return mn;
}

/** quantile (type 7, as R / numpy default) of a sorted array */
export function quantileSorted(xs: ArrayLike<number>, q: number): number {
  const n = xs.length; if (!n) return NaN;
  const h = (n - 1) * q, lo = Math.floor(h), hi = Math.ceil(h);
  return xs[lo] + (h - lo) * (xs[hi] - xs[lo]);
}
