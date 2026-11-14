// The assignment problem: pair rows with columns at the lowest total cost.
//
// This follows the same shortest-augmenting-path method scipy uses for
// linear_sum_assignment (Crouse, 2016), step for step, so that both pick the
// same answer even when several answers tie. test/assignment.test.ts checks it
// against scipy's output.

export interface Assignment {
  rows: Int32Array;
  cols: Int32Array;
}

/** `cost` is nr x nc, row by row. Returns min(nr, nc) pairs, ordered by row. */
export function linearSumAssignment(cost: ArrayLike<number>, nr: number, nc: number): Assignment {
  if (nr === 0 || nc === 0) return { rows: new Int32Array(0), cols: new Int32Array(0) };

  // A tall matrix is solved on its transpose.
  const transpose = nc < nr;
  let c: ArrayLike<number> = cost;
  if (transpose) {
    const flipped = new Float64Array(nr * nc);
    for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) flipped[j * nr + i] = cost[i * nc + j];
    c = flipped;
    [nr, nc] = [nc, nr];
  }

  const u = new Float64Array(nr);
  const v = new Float64Array(nc);
  const shortest = new Float64Array(nc);
  const path = new Int32Array(nc).fill(-1);
  const col4row = new Int32Array(nr).fill(-1);
  const row4col = new Int32Array(nc).fill(-1);
  const SR = new Uint8Array(nr);
  const SC = new Uint8Array(nc);
  const remaining = new Int32Array(nc);

  for (let curRow = 0; curRow < nr; curRow++) {
    // Find the shortest augmenting path from curRow to an unassigned column.
    let minVal = 0;
    let i = curRow;
    let numRemaining = nc;
    // Filled in reverse so that a constant matrix gives the identity pairing.
    for (let it = 0; it < nc; it++) remaining[it] = nc - it - 1;
    SR.fill(0);
    SC.fill(0);
    shortest.fill(Infinity);
    let sink = -1;
    while (sink === -1) {
      let index = -1;
      let lowest = Infinity;
      SR[i] = 1;
      for (let it = 0; it < numRemaining; it++) {
        const j = remaining[it];
        const r = minVal + c[i * nc + j] - u[i] - v[j];
        if (r < shortest[j]) {
          path[j] = i;
          shortest[j] = r;
        }
        // Among equally cheap columns, prefer one that is still unassigned.
        if (shortest[j] < lowest || (shortest[j] === lowest && row4col[j] === -1)) {
          lowest = shortest[j];
          index = it;
        }
      }
      minVal = lowest;
      if (minVal === Infinity) throw new Error('cost matrix is infeasible');
      const j = remaining[index];
      if (row4col[j] === -1) sink = j;
      else i = row4col[j];
      SC[j] = 1;
      remaining[index] = remaining[--numRemaining];
    }

    // Update the dual variables.
    u[curRow] += minVal;
    for (let r = 0; r < nr; r++) {
      if (SR[r] && r !== curRow) u[r] += minVal - shortest[col4row[r]];
    }
    for (let j = 0; j < nc; j++) {
      if (SC[j]) v[j] -= minVal - shortest[j];
    }

    // Walk the path back, flipping assignments along it.
    let j = sink;
    for (;;) {
      const r = path[j];
      row4col[j] = r;
      const previous = col4row[r];
      col4row[r] = j;
      j = previous;
      if (r === curRow) break;
    }
  }

  const rows = new Int32Array(nr);
  const cols = new Int32Array(nr);
  if (transpose) {
    const order = Array.from({ length: nr }, (_, k) => k).sort((a, b) => col4row[a] - col4row[b]);
    order.forEach((k, at) => {
      rows[at] = col4row[k];
      cols[at] = k;
    });
  } else {
    for (let r = 0; r < nr; r++) {
      rows[r] = r;
      cols[r] = col4row[r];
    }
  }
  return { rows, cols };
}
