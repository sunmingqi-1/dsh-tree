import dagre from '@dagrejs/dagre'
import type { Turn } from './tree'

type Node = Pick<Turn, 'id' | 'parentId'>
export type Positions = Record<string, { x: number; y: number }>
export type Sizes = Record<string, { width: number; height: number }>
export const LAYOUT_VERSION = 2
const FALLBACK = { width: 560, height: 320 }
const COLUMN_GAP = 72
const ROW_GAP = 88

export function sizeOf(id: string, sizes: Sizes) {
  return sizes[id] || FALLBACK
}

export function arrange(nodes: Node[], sizes: Sizes = {}): Positions {
  if (!nodes.length) return {}
  const graph = new dagre.graphlib.Graph()
    .setGraph({ rankdir: 'TB', ranksep: ROW_GAP, nodesep: COLUMN_GAP })
    .setDefaultEdgeLabel(() => ({}))
  for (const node of nodes) graph.setNode(node.id, { ...sizeOf(node.id, sizes) })
  for (const node of nodes) if (node.parentId) graph.setEdge(node.parentId, node.id)
  dagre.layout(graph)
  const root = nodes.find((node) => !node.parentId) || nodes[0]
  const origin = graph.node(root.id)
  const rootSize = sizeOf(root.id, sizes)
  const tops = new Map<number, number>()
  for (const node of nodes) {
    const point = graph.node(node.id)
    const top = point.y - sizeOf(node.id, sizes).height / 2
    tops.set(point.y, Math.min(tops.get(point.y) ?? Infinity, top))
  }
  return Object.fromEntries(
    nodes.map((node) => {
      const point = graph.node(node.id)
      const size = sizeOf(node.id, sizes)
      return [
        node.id,
        {
          x: point.x - size.width / 2 - origin.x + rootSize.width / 2,
          y: tops.get(point.y) - origin.y + rootSize.height / 2,
        },
      ]
    }),
  )
}

export function extendDown(nodes: Node[], stored: Positions, sizes: Sizes): Positions {
  if (nodes.every((node) => stored[node.id])) return stored
  const positions = { ...stored }
  const byId = new Map(nodes.map((node) => [node.id, node]))
  function place(node: Node) {
    if (positions[node.id]) return positions[node.id]
    const parent = byId.get(node.parentId)
    if (parent) place(parent)
    const size = sizeOf(node.id, sizes)
    const next = parent
      ? {
          x: positions[parent.id].x,
          y: positions[parent.id].y + sizeOf(parent.id, sizes).height + ROW_GAP,
        }
      : { x: 0, y: 0 }
    while (
      Object.entries(positions).some(([id, point]) => {
        const other = sizeOf(id, sizes)
        return (
          next.x < point.x + other.width + COLUMN_GAP &&
          next.x + size.width + COLUMN_GAP > point.x &&
          next.y < point.y + other.height + ROW_GAP &&
          next.y + size.height + ROW_GAP > point.y
        )
      })
    )
      next.x += size.width + COLUMN_GAP
    positions[node.id] = next
    return next
  }
  for (const node of nodes) place(node)
  return positions
}
