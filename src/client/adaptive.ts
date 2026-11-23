import type { Positions, Sizes } from './layout'

export type Rect = { x: number; y: number; width: number; height: number }
export type Rects = Record<string, Rect>
export const NODE_GAP = 48
export const FOLLOW_RANGE = 96
const EPS = 0.001
const CELL = 640

const right = (r: Rect) => r.x + r.width
const bottom = (r: Rect) => r.y + r.height
const overlap = (a: number, endA: number, b: number, endB: number) => Math.min(endA, endB) - Math.max(a, b) > EPS
export const conflicts = (a: Rect, b: Rect) =>
  a.x < right(b) + NODE_GAP - EPS && right(a) + NODE_GAP > b.x + EPS &&
  a.y < bottom(b) + NODE_GAP - EPS && bottom(a) + NODE_GAP > b.y + EPS

// Check the entire swept rectangle, not just its last frame. A fast mouse
// event can jump across a neighbour without ending inside its rectangle.
function swept(start: Rect, end: Rect, target: Rect) {
  let low = 0, high = 1
  for (const [from, to] of [
    [right(target) + NODE_GAP - start.x, right(target) + NODE_GAP - end.x],
    [right(start) + NODE_GAP - target.x, right(end) + NODE_GAP - target.x],
    [bottom(target) + NODE_GAP - start.y, bottom(target) + NODE_GAP - end.y],
    [bottom(start) + NODE_GAP - target.y, bottom(end) + NODE_GAP - target.y],
  ]) {
    const delta = to - from
    if (Math.abs(delta) < EPS) { if (from <= EPS) return false }
    else if (delta > 0) low = Math.max(low, (EPS - from) / delta)
    else high = Math.min(high, (EPS - from) / delta)
    if (low >= high) return false
  }
  return high > 0 && low < 1
}

// Broad phase: a pointer movement only needs nearby/swept rectangles, not
// every pair in the tree. Settled rectangles stay fixed during one solve.
export class Neighbours {
  private cells = new Map<string, string[]>()
  private all: string[] = []
  private overflow: string[] = []
  private keys(rect: Rect): string[] | null {
    const left = Math.floor(rect.x / CELL), top = Math.floor(rect.y / CELL)
    const endX = Math.floor(right(rect) / CELL), endY = Math.floor(bottom(rect) / CELL)
    if ((endX - left + 1) * (endY - top + 1) > 4096) return null
    const keys = []
    for (let x = left; x <= endX; x++) for (let y = top; y <= endY; y++) keys.push(x + ':' + y)
    return keys
  }
  add(id: string, start: Rect, end: Rect) {
    const keys = this.keys({
      x: Math.min(start.x, end.x) - NODE_GAP,
      y: Math.min(start.y, end.y) - NODE_GAP,
      width: Math.max(right(start), right(end)) - Math.min(start.x, end.x) + NODE_GAP * 2,
      height: Math.max(bottom(start), bottom(end)) - Math.min(start.y, end.y) + NODE_GAP * 2,
    })
    this.all.push(id)
    if (!keys) { this.overflow.push(id); return }
    for (const key of keys) {
      const values = this.cells.get(key) || []
      values.push(id)
      this.cells.set(key, values)
    }
  }
  query(rect: Rect) {
    const keys = this.keys(rect)
    if (!keys) return this.all
    const ids = new Set(this.overflow)
    for (const key of keys) for (const id of this.cells.get(key) || []) ids.add(id)
    return [...ids]
  }
}

// Only an edge that moved inward pulls its existing nearby contact chain.
// Every calculation uses the gesture's initial geometry, so reversing the
// pointer restores the starting layout instead of accumulating displacement.
function contract(base: Rects, rects: Rects, id: string, next: Rect) {
  const start = base[id]
  const moves: ['x' | 'y', number, 1 | -1][] = []
  if (next.width < start.width - EPS) {
    if (right(next) < right(start)) moves.push(['x', right(next) - right(start), 1])
    if (next.x > start.x) moves.push(['x', next.x - start.x, -1])
  }
  if (next.height < start.height - EPS) {
    if (bottom(next) < bottom(start)) moves.push(['y', bottom(next) - bottom(start), 1])
    if (next.y > start.y) moves.push(['y', next.y - start.y, -1])
  }
  if (!moves.length) return
  const contacts = new Neighbours()
  for (const [id, rect] of Object.entries(base)) contacts.add(id, rect, rect)
  for (const [axis, amount, sign] of moves) {
    const visited = new Set([id]), queue = [id]
    for (let index = 0; index < queue.length; index++) {
      const source = base[queue[index]]
      const nearby = contacts.query({
        x: source.x - FOLLOW_RANGE, y: source.y - FOLLOW_RANGE,
        width: source.width + FOLLOW_RANGE * 2, height: source.height + FOLLOW_RANGE * 2,
      })
      for (const targetId of nearby) {
        if (visited.has(targetId)) continue
        const target = base[targetId]
        const aligned = axis === 'x'
          ? overlap(source.y, bottom(source), target.y, bottom(target))
          : overlap(source.x, right(source), target.x, right(target))
        const gap = axis === 'x'
          ? sign > 0 ? target.x - right(source) : source.x - right(target)
          : sign > 0 ? target.y - bottom(source) : source.y - bottom(target)
        if (!aligned || gap < -EPS || gap > FOLLOW_RANGE + EPS) continue
        visited.add(targetId)
        queue.push(targetId)
        rects[targetId][axis] += amount
      }
    }
  }
}

export function adaptLayout(base: Rects, activeId: string, next: Rect, liveSizes?: Sizes): Positions {
  if (!base[activeId]) return Object.fromEntries(Object.entries(base).map(([id, r]) => [id, { x: r.x, y: r.y }]))
  const rects: Rects = Object.fromEntries(Object.entries(base).map(([id, r]) => [id, { ...r, ...liveSizes?.[id] }]))
  rects[activeId] = { ...next }
  contract(base, rects, activeId, next)
  const origin = base[activeId]
  const cx = origin.x + origin.width / 2, cy = origin.y + origin.height / 2
  const distance = (r: Rect) => Math.hypot(r.x + r.width / 2 - cx, r.y + r.height / 2 - cy)
  const ordered = Object.keys(base).filter(id => id !== activeId)
    .sort((a, b) => distance(base[a]) - distance(base[b]) || a.localeCompare(b))
  const rank = new Map([activeId, ...ordered].map((id, index) => [id, index]))
  const neighbours = new Neighbours()
  neighbours.add(activeId, origin, next)
  let settled = 1
  for (const id of ordered) {
    const original = base[id], target = rects[id]
    const sx = original.x + original.width / 2 >= cx ? 1 : -1
    const sy = original.y + original.height / 2 >= cy ? 1 : -1
    // A target moves monotonically out from the active card on either axis.
    // This prevents reciprocal pushes/cycles even for initially stacked cards.
    for (let pass = 0; pass <= settled; pass++) {
      let moved = false
      const sources = neighbours.query(target).sort((a, b) => rank.get(a) - rank.get(b))
      for (const sourceId of sources) {
        const source = rects[sourceId]
        const oldSource = base[sourceId]
        const gapX = sx > 0 ? original.x - right(oldSource) : oldSource.x - right(original)
        const gapY = sy > 0 ? original.y - bottom(oldSource) : oldSource.y - bottom(original)
        const dx = sx > 0 ? right(source) + NODE_GAP - target.x : target.x + target.width + NODE_GAP - source.x
        const dy = sy > 0 ? bottom(source) + NODE_GAP - target.y : target.y + target.height + NODE_GAP - source.y
        const axis = gapX >= -EPS || gapY >= -EPS
          ? gapX >= -EPS && (gapY < -EPS || gapX <= gapY) ? 'x' : 'y'
          : dx <= dy ? 'x' : 'y'
        const aligned = axis === 'x'
          ? source.y < bottom(target) + NODE_GAP - EPS && bottom(source) + NODE_GAP > target.y + EPS
          : source.x < right(target) + NODE_GAP - EPS && right(source) + NODE_GAP > target.x + EPS
        if (!conflicts(source, target) && !(
          aligned && (axis === 'x' ? dx : dy) > EPS && swept(oldSource, source, target)
        )) continue
        if (axis === 'x') target.x += sx * dx
        else target.y += sy * dy
        moved = true
      }
      if (!moved) break
    }
    neighbours.add(id, original, target)
    settled++
  }
  return Object.fromEntries(Object.entries(rects).map(([id, r]) => [id, { x: r.x, y: r.y }]))
}

// Cache the stationary geometry for one pointer gesture. For short pushes solve
// only the swept neighbours. Long chains and shrink-to-follow use the full solver.
export function gestureLayout(base: Rects, id: string) {
  const index = new Neighbours()
  for (const [key, rect] of Object.entries(base)) index.add(key, rect, rect)
  return (next: Rect, changedSizes?: Sizes): Positions => {
    const start = base[id]
    if (!start || changedSizes || next.width < start.width || next.height < start.height)
      return adaptLayout(base, id, next, changedSizes)
    const nearby = { [id]: start }
    let positions: Positions = { [id]: { x: next.x, y: next.y } }
    for (let pass = 0; pass < 4; pass++) {
      let added = false
      for (const [source, point] of Object.entries(positions)) {
        const old = base[source]
        if (source !== id && point.x === old.x && point.y === old.y) continue
        const end = source === id ? next : { ...old, ...point }
        const x = Math.min(old.x, end.x), y = Math.min(old.y, end.y)
        const area = { x, y, width: Math.max(right(old), right(end)) - x, height: Math.max(bottom(old), bottom(end)) - y }
        for (const other of index.query(area)) {
          if (nearby[other] || !conflicts(area, base[other])) continue
          nearby[other] = base[other]
          added = true
        }
      }
      if (!added) return positions
      positions = adaptLayout(nearby, id, next)
    }
    return adaptLayout(base, id, next)
  }
}
