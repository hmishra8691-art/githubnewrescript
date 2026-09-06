/**
 * Small dense linear algebra — enough for regression, PCA and clustering on
 * survey-sized matrices (hundreds of variables at most). Plain arrays, no
 * dependencies, deterministic.
 */
export type Matrix = number[][];

export const zeros = (r: number, c: number): Matrix => Array.from({ length: r }, () => new Array(c).fill(0));
export const identity = (n: number): Matrix => zeros(n, n).map((row, i) => { row[i] = 1; return row; });
export const transpose = (a: Matrix): Matrix => (a.length ? a[0].map((_, j) => a.map((row) => row[j])) : []);

export function multiply(a: Matrix, b: Matrix): Matrix {
  const n = a.length, m = b[0]?.length ?? 0, k = b.length;
  const out = zeros(n, m);
  for (let i = 0; i < n; i++) for (let p = 0; p < k; p++) {
    const aip = a[i][p]; if (aip === 0) continue;
    for (let j = 0; j < m; j++) out[i][j] += aip * b[p][j];
  }
  return out;
}

export const multiplyVec = (a: Matrix, v: number[]): number[] => a.map((row) => row.reduce((t, x, j) => t + x * v[j], 0));

/** Inverse via Gauss-Jordan with partial pivoting; null when singular. */
export function inverse(a: Matrix): Matrix | null {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...identity(n)[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv], m[col]];
    const d = m[col][col];
    for (let j = 0; j < 2 * n; j++) m[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col]; if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) m[r][j] -= f * m[col][j];
    }
  }
  return m.map((row) => row.slice(n));
}

/** Solve A x = b (least squares safe when A is X'X); null when singular. */
export function solve(a: Matrix, b: number[]): number[] | null {
  const inv = inverse(a);
  return inv ? multiplyVec(inv, b) : null;
}

/**
 * Eigen-decomposition of a symmetric matrix by cyclic Jacobi rotations.
 * Returns eigenvalues (descending) and matching unit eigenvectors (columns).
 */
export function symmetricEigen(a: Matrix, maxSweeps = 100): { values: number[]; vectors: Matrix } {
  const n = a.length;
  const m = a.map((r) => [...r]);
  let v = identity(n);
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += m[i][j] * m[i][j];
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(m[p][q]) < 1e-15) continue;
      const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const mkp = m[k][p], mkq = m[k][q];
        m[k][p] = c * mkp - s * mkq; m[k][q] = s * mkp + c * mkq;
      }
      for (let k = 0; k < n; k++) {
        const mpk = m[p][k], mqk = m[q][k];
        m[p][k] = c * mpk - s * mqk; m[q][k] = s * mpk + c * mqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const order = m.map((_, i) => i).sort((x, y) => m[y][y] - m[x][x]);
  return { values: order.map((i) => m[i][i]), vectors: v.map((row) => order.map((i) => row[i])) };
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
export const dot = (a: number[], b: number[]): number => a.reduce((t, x, i) => t + x * b[i], 0);
