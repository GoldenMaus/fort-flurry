// Fort Flurry — shared pathfinding: one Dijkstra outward from the goal gives every
// walking foe its next step at the cost of an array read.
//
// Walls are passable at a price rather than impassable. A fully sealed fort must still
// produce a route, and the wall that route crosses is exactly what `blocker` tells a foe
// to attack. Pricing by hp means foes prefer to break in through the weak spot.

import { BUILD, CELL, SIM_HZ } from './constants.js';

const REBUILD_EVERY_TICKS = Math.round(SIM_HZ / 2);
const STRAIGHT = 1;
const DIAGONAL = Math.SQRT2;
const STRUCT_BASE_COST = 8;
const STRUCT_HP_DIVISOR = 20;
// Price of walking close to something, so paths run down the middle of a lane. A Big Kid
// fills a cell exactly and Steve fills two; hugging a corner is how they wedge.
const NEAR_OBSTACLE_COST = 2.5;
const NEAR_STRUCT_COST = 1;
const OUTER_OBSTACLE_COST = 0.75;

const NEIGHBOURS = [
  [1, 0, STRAIGHT], [-1, 0, STRAIGHT], [0, 1, STRAIGHT], [0, -1, STRAIGHT],
  [1, 1, DIAGONAL], [1, -1, DIAGONAL], [-1, 1, DIAGONAL], [-1, -1, DIAGONAL],
];

// Binary min-heap over (key, cell). Stale entries are skipped on pop instead of being
// decreased in place, which keeps this small. Ties fall to the lower cell index so a
// rebuild is identical on every host.
class CellHeap {
  constructor() {
    this.keys = [];
    this.cells = [];
  }

  get size() {
    return this.keys.length;
  }

  before(i, j) {
    return this.keys[i] < this.keys[j] || (this.keys[i] === this.keys[j] && this.cells[i] < this.cells[j]);
  }

  swap(i, j) {
    const k = this.keys[i];
    this.keys[i] = this.keys[j];
    this.keys[j] = k;
    const c = this.cells[i];
    this.cells[i] = this.cells[j];
    this.cells[j] = c;
  }

  push(key, cell) {
    this.keys.push(key);
    this.cells.push(cell);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  // Leaves the popped key and cell in topKey/topCell, so the hot loop allocates nothing.
  pop() {
    this.topKey = this.keys[0];
    this.topCell = this.cells[0];
    const lastKey = this.keys.pop();
    const lastCell = this.cells.pop();
    const n = this.keys.length;
    if (n === 0) return;
    this.keys[0] = lastKey;
    this.cells[0] = lastCell;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let least = i;
      if (left < n && this.before(left, least)) least = left;
      if (right < n && this.before(right, least)) least = right;
      if (least === i) return;
      this.swap(i, least);
      i = least;
    }
  }
}

export class FlowField {
  constructor(g, goalCells) {
    this.g = g;
    const { cols, rows } = g.cw;
    this.cols = cols;
    this.rows = rows;
    const cells = cols * rows;
    this.goals = [];
    let sumX = 0;
    let sumY = 0;
    for (const { cx, cy } of goalCells) {
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
      this.goals.push(cy * cols + cx);
      sumX += (cx + 0.5) * CELL;
      sumY += (cy + 0.5) * CELL;
    }
    const goalCount = Math.max(1, this.goals.length);
    this.goalX = sumX / goalCount;
    this.goalY = sumY / goalCount;

    this.cost = new Float64Array(cells);
    this.next = new Int32Array(cells);
    this.enter = new Float64Array(cells);
    this.solidStruct = new Uint8Array(cells);
    this.obstacle = new Uint8Array(cells);
    this.clearance = new Float64Array(cells);
    this.rebuilds = 0;
    this.builtRev = g.structRev;
    this.builtTick = g.tick;
    this.measureObstacles();
    this.rebuild();
  }

  // Obstacles never move, so their clearance pricing is worked out once per field.
  measureObstacles() {
    const { g, cols, rows } = this;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        if (g.cw.isObstacleCell(cx, cy)) this.obstacle[cy * cols + cx] = 1;
      }
    }
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        let price = 0;
        for (let oy = -2; oy <= 2 && price < NEAR_OBSTACLE_COST; oy++) {
          for (let ox = -2; ox <= 2; ox++) {
            const x = cx + ox;
            const y = cy + oy;
            if (x < 0 || y < 0 || x >= cols || y >= rows || this.obstacle[y * cols + x] === 0) continue;
            const near = Math.abs(ox) <= 1 && Math.abs(oy) <= 1;
            price = Math.max(price, near ? NEAR_OBSTACLE_COST : OUTER_OBSTACLE_COST);
          }
        }
        this.clearance[cy * cols + cx] = price;
      }
    }
  }

  priceStructs() {
    const { g, cols, rows, enter, solidStruct } = this;
    enter.set(this.clearance);
    solidStruct.fill(0);
    for (const s of g.structs.values()) {
      const spec = BUILD[s.kind];
      if (!spec.solid) continue;
      const size = spec.size || 1;
      const price = STRUCT_BASE_COST + s.hp / STRUCT_HP_DIVISOR;
      for (let y = s.cy; y < s.cy + size; y++) {
        for (let x = s.cx; x < s.cx + size; x++) {
          if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
          const i = y * cols + x;
          solidStruct[i] = 1;
          enter[i] += price;
        }
      }
      for (let y = s.cy - 1; y <= s.cy + size; y++) {
        for (let x = s.cx - 1; x <= s.cx + size; x++) {
          if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
          enter[y * cols + x] += NEAR_STRUCT_COST;
        }
      }
    }
    for (const goal of this.goals) enter[goal] = 0;
  }

  rebuild() {
    const { g, cols, rows, cost, next, enter, solidStruct, obstacle } = this;
    this.rebuilds += 1;
    this.builtRev = g.structRev;
    this.builtTick = g.tick;
    this.priceStructs();
    cost.fill(Infinity);
    next.fill(-1);

    const heap = new CellHeap();
    for (const goal of this.goals) {
      cost[goal] = 0;
      heap.push(0, goal);
    }
    while (heap.size > 0) {
      heap.pop();
      const from = heap.topCell;
      if (heap.topKey > cost[from]) continue;
      const fx = from % cols;
      const fy = (from - fx) / cols;
      for (let n = 0; n < 8; n++) {
        const [ox, oy, length] = NEIGHBOURS[n];
        const x = fx + ox;
        const y = fy + oy;
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        const to = y * cols + x;
        if (obstacle[to] === 1) continue;
        if (length === DIAGONAL) {
          // No squeezing between two corners, and no entering a wall corner-first: a foe
          // has to arrive square-on for `blocker` to name the wall it is actually facing.
          const sideA = fy * cols + x;
          const sideB = y * cols + fx;
          if (obstacle[sideA] === 1 || obstacle[sideB] === 1) continue;
          if (solidStruct[sideA] === 1 || solidStruct[sideB] === 1) continue;
          if (solidStruct[from] === 1 || solidStruct[to] === 1) continue;
        }
        const reached = cost[from] + length + enter[from];
        if (reached < cost[to]) {
          cost[to] = reached;
          next[to] = from;
          heap.push(reached, to);
        }
      }
    }
    this.routeObstacleCells();
  }

  // A body knocked or hopped into an obstacle cell still needs a way back out.
  routeObstacleCells() {
    const { cols, rows, cost, next, obstacle } = this;
    for (let i = 0; i < next.length; i++) {
      if (obstacle[i] === 0) continue;
      const cx = i % cols;
      const cy = (i - cx) / cols;
      let best = Infinity;
      for (let n = 0; n < 8; n++) {
        const x = cx + NEIGHBOURS[n][0];
        const y = cy + NEIGHBOURS[n][1];
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        const j = y * cols + x;
        if (obstacle[j] === 0 && cost[j] < best) {
          best = cost[j];
          next[i] = j;
        }
      }
    }
  }

  refresh() {
    const { g } = this;
    if (g.structRev !== this.builtRev && g.tick - this.builtTick >= REBUILD_EVERY_TICKS) this.rebuild();
  }

  dirAt(x, y) {
    this.refresh();
    const { g, cols, rows } = this;
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(x / CELL)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(y / CELL)));
    const cell = cy * cols + cx;
    if (this.cost[cell] === 0) return { dx: 0, dy: 0, blocker: null };
    const step = this.next[cell];
    let tx = this.goalX;
    let ty = this.goalY;
    let blocker = null;
    if (step >= 0) {
      const nx = step % cols;
      const ny = (step - nx) / cols;
      tx = (nx + 0.5) * CELL;
      ty = (ny + 0.5) * CELL;
      if (this.solidStruct[step] === 1) blocker = g.structAt(nx, ny);
    }
    const dx = tx - x;
    const dy = ty - y;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length === 0) return { dx: 0, dy: 0, blocker };
    return { dx: dx / length, dy: dy / length, blocker };
  }
}
