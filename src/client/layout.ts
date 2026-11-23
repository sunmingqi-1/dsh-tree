import type { Turn } from './tree'
import { isQuoteBranch } from './tree.ts'
import { DEFAULT_CARD_SIZE } from './cardSize.ts'
import { conflicts, Neighbours, type Rect } from './adaptive.ts'

type Node = Pick<Turn, 'id' | 'parentId'> & Partial<Pick<Turn, 'branchKind' | 'anchor'>>
export type Positions = Record<string, { x: number; y: number }>
export type Sizes = Record<string, { width: number; height: number }>
export const LAYOUT_VERSION = 2
const COLUMN_GAP = 72
const ROW_GAP = 88

export function sizeOf(id: string, sizes: Sizes) {
  return sizes[id] || DEFAULT_CARD_SIZE
}

function arrangeDown(order: Node[], children: Map<string | null, Node[]>, sizes: Sizes): Positions {
  const widths = new Map<string, number>()
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i]
    const row = children.get(n.id) || []
    const span = row.reduce((sum, child) => sum + widths.get(child.id)! + COLUMN_GAP, -COLUMN_GAP)
    widths.set(n.id, Math.max(sizeOf(n.id, sizes).width, span))
  }
  const positions: Positions = {}
  // Process one level at a time. Centre each sibling row under its parent
  // and start the next level below the tallest card of this one.
  let first = 0, end = 1, y = 0
  positions[order[0].id] = { x: 0, y }
  while (first < order.length) {
    let height = 0, nextEnd = end
    for (let i = first; i < end; i++) {
      const n = order[i], size = sizeOf(n.id, sizes)
      const row = children.get(n.id) || []
      const span = row.reduce((sum, child) => sum + widths.get(child.id)! + COLUMN_GAP, -COLUMN_GAP)
      let left = positions[n.id].x + (size.width - span) / 2
      positions[n.id].y = y
      for (const child of row) {
        const width = widths.get(child.id)!
        positions[child.id] = { x: left + (width - sizeOf(child.id, sizes).width) / 2, y: 0 }
        left += width + COLUMN_GAP
      }
      nextEnd += row.length
      height = Math.max(height, size.height)
    }
    y += height + ROW_GAP
    first = end
    end = nextEnd
  }
  return positions
}

// Each subtree reserves its own rectangle. Quote subtrees stack on the right,
// while card follow-ups share a row below the parent and its quote subtrees.
export function arrange(nodes: Node[], sizes: Sizes = {}): Positions {
  const children = new Map<string | null, Node[]>()
  for (const node of nodes) {
    const list = children.get(node.parentId)
    if (list) list.push(node)
    else children.set(node.parentId, [node])
  }
  const order = [...(children.get(null) || [])]
  for (let i = 0; i < order.length; i++) {
    for (const child of children.get(order[i].id) || []) order.push(child)
  }
  if (!order.length) return {}
  if (children.get(null)?.length === 1 && !nodes.some(n => n.parentId && isQuoteBranch(n)))
    return arrangeDown(order, children, sizes)
  const bounds = new Map<string, { width: number; height: number }>()
  const offsets: Positions = {}
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i], size = sizeOf(node.id, sizes)
    const list = children.get(node.id) || []
    let rightHeight = 0, width = size.width
    for (const child of list.filter(isQuoteBranch)) {
      const box = bounds.get(child.id)!
      offsets[child.id] = { x: size.width + COLUMN_GAP, y: rightHeight }
      rightHeight += box.height + ROW_GAP
      width = Math.max(width, size.width + COLUMN_GAP + box.width)
    }
    const topHeight = Math.max(size.height, rightHeight - ROW_GAP)
    let bottomWidth = 0, height = topHeight
    for (const child of list.filter(n => !isQuoteBranch(n))) {
      const box = bounds.get(child.id)!
      // A narrow continuation fits below its parent, alongside long quote branches.
      const childY = bottomWidth + box.width <= size.width ? size.height : topHeight
      offsets[child.id] = { x: bottomWidth, y: childY + ROW_GAP }
      bottomWidth += box.width + COLUMN_GAP
      height = Math.max(height, childY + ROW_GAP + box.height)
    }
    bounds.set(node.id, { width: Math.max(width, bottomWidth - COLUMN_GAP), height })
  }
  for (const n of order) {
    const origin = offsets[n.parentId] || { x: 0, y: 0 }
    const offset = offsets[n.id] || { x: 0, y: 0 }
    offsets[n.id] = { x: origin.x + offset.x, y: origin.y + offset.y }
  }
  return offsets
}

// Reserve cards that stayed on screen first. Restored or new branches take the
// first free position along their outlet, without displacing the working area.
export function extendDown(nodes: Node[], stored: Positions, sizes: Sizes, pinned?: ReadonlySet<string>): Positions {
  const fixed = (id: string) => stored[id] && (!pinned || pinned.has(id))
  if (nodes.every(node => fixed(node.id))) return stored
  const occupied = new Neighbours()
  const boxes: Record<string, Rect> = {}
  const children = new Map<string | null, Node[]>()
  function reserve(id: string, rect: Rect) {
    boxes[id] = rect
    occupied.add(id, rect, rect)
  }
  for (const node of nodes) {
    const list = children.get(node.parentId)
    if (list) list.push(node)
    else children.set(node.parentId, [node])
    if (fixed(node.id)) reserve(node.id, { ...stored[node.id], ...sizeOf(node.id, sizes) })
  }
  let positions = stored
  // Same-sized new siblings share a starting lane. Once a spot is occupied,
  // later siblings need not repeat the entire search from the parent.
  const laneEnds = new Map<string, number>()
  const order = [...(children.get(null) || [])]
  for (let i = 0; i < order.length; i++) {
    const node = order[i]
    for (const child of children.get(node.id) || []) order.push(child)
    if (boxes[node.id]) continue
    const right = isQuoteBranch(node)
    const parent = node.parentId && boxes[node.parentId]
    const oldParent = node.parentId && stored[node.parentId]
    const saved = stored[node.id]
    const point = saved ? {
      x: saved.x + (parent && oldParent ? parent.x - oldParent.x : 0),
      y: saved.y + (parent && oldParent ? parent.y - oldParent.y : 0),
    } : {
      x: parent ? parent.x + (right ? parent.width + COLUMN_GAP : 0) : 0,
      y: parent ? parent.y + (right ? 0 : parent.height + ROW_GAP) : 0,
    }
    const rect = { ...point, ...sizeOf(node.id, sizes) }
    const lane = !saved && parent ? [node.parentId, right, rect.width, rect.height].join(':') : null
    const axis = right ? 'y' : 'x'
    if (lane) rect[axis] = laneEnds.get(lane) ?? rect[axis]
    for (;;) {
      const hits = occupied.query(rect).map(id => boxes[id]).filter(other => conflicts(rect, other))
      if (!hits.length) break
      for (const other of hits) {
        if (right) rect.y = Math.max(rect.y, other.y + other.height + ROW_GAP)
        else rect.x = Math.max(rect.x, other.x + other.width + COLUMN_GAP)
      }
    }
    reserve(node.id, rect)
    if (lane) laneEnds.set(lane, right ? rect.y + rect.height + ROW_GAP : rect.x + rect.width + COLUMN_GAP)
    if (saved?.x === rect.x && saved.y === rect.y) continue
    if (positions === stored) positions = { ...stored }
    positions[node.id] = { x: rect.x, y: rect.y }
  }
  return positions
}

// Folded cards travel with their closest visible ancestor. Their saved offsets
// survive moving the parent, automatic arrangement and nested folds.
export function moveBranches(children: Map<string | null, Node[]>, stored: Positions, visible: ReadonlySet<string>, placed: Positions): Positions {
  const positions = { ...stored }
  const queue = (children.get(null) || []).map(node => ({ node, dx: 0, dy: 0 }))
  for (let i = 0; i < queue.length; i++) {
    let { node, dx, dy } = queue[i]
    const old = stored[node.id]
    const point = visible.has(node.id) && placed[node.id]
    if (point) {
      positions[node.id] = point
      dx = old ? point.x - old.x : 0
      dy = old ? point.y - old.y : 0
    } else if (old && (dx || dy)) positions[node.id] = { x: old.x + dx, y: old.y + dy }
    for (const child of children.get(node.id) || []) queue.push({ node: child, dx, dy })
  }
  return positions
}
