import { useMemo, useSyncExternalStore } from 'react'
import { isQuoteBranch, type CanvasNode } from './tree.ts'

export type Direction = 'card' | 'quote'
type Group = Direction | 'both'
type Folds = {
  outlets: Record<string, Group>
  // A child can override its outlet in either direction.
  branches: Record<string, boolean>
}

export const directionOf = (turn: CanvasNode): Direction => isQuoteBranch(turn) ? 'quote' : 'card'

const key = 'dsh-study-tree:folds'
const changed = 'study-tree-folds'
const snapshot = () => localStorage.getItem(key) || '{}'
export function readFolds(raw: string): Folds {
  const folds: Folds = { outlets: Object.create(null), branches: Object.create(null) }
  try {
    const stored = JSON.parse(raw)
    for (const [id, value] of Object.entries(stored.version === 2 ? stored.outlets : stored)) {
      if (value === true || value === 'both') folds.outlets[id] = 'both'
      else if (value === 'quote' || value === 'card') folds.outlets[id] = value
    }
    if (stored.version === 2) for (const [id, value] of Object.entries(stored.branches)) {
      if (typeof value === 'boolean') folds.branches[id] = value
    }
  } catch { /* Ignore invalid device preferences. */ }
  return folds
}
function subscribe(notify: () => void) {
  const storage = (event: StorageEvent) => { if (!event.key || event.key === key) notify() }
  window.addEventListener('storage', storage)
  window.addEventListener(changed, notify)
  return () => {
    window.removeEventListener('storage', storage)
    window.removeEventListener(changed, notify)
  }
}
export function useBranchFolds() {
  const raw = useSyncExternalStore(subscribe, snapshot)
  return useMemo(() => readFolds(raw), [raw])
}
function save(folds: Folds) {
  localStorage.setItem(key, JSON.stringify({ version: 2, ...folds }))
  window.dispatchEvent(new Event(changed))
}

export function setBranchFolds(outlets: Iterable<readonly [string, Group]>, folded: boolean, children: ReadonlyMap<string | null, CanvasNode[]>) {
  const folds = readFolds(snapshot())
  let dirty = false
  for (const [id, group] of outlets) {
    const previous = folds.outlets[id]
    const card = group === 'quote' ? previous === 'both' || previous === 'card' : folded
    const quote = group === 'card' ? previous === 'both' || previous === 'quote' : folded
    const next = card && quote ? 'both' : card ? 'card' : quote ? 'quote' : undefined
    if (next !== previous) {
      if (next) folds.outlets[id] = next
      else delete folds.outlets[id]
      dirty = true
    }
    for (const child of children.get(id) || []) {
      if ((group === 'both' || directionOf(child) === group) && child.id in folds.branches) {
        delete folds.branches[child.id]
        dirty = true
      }
    }
  }
  if (dirty) save(folds)
}

function outletFolded(folds: Folds, node: CanvasNode) {
  const group = node.parentId && folds.outlets[node.parentId]
  return group === 'both' || group === directionOf(node)
}

export function setIndividualFolds(nodes: Iterable<CanvasNode>, folded: boolean) {
  const folds = readFolds(snapshot())
  let dirty = false
  for (const node of nodes) {
    if (!node.parentId) continue
    const inherited = outletFolded(folds, node)
    if ((folds.branches[node.id] ?? inherited) === folded) continue
    if (!folded && !inherited) delete folds.branches[node.id]
    else folds.branches[node.id] = folded
    dirty = true
  }
  if (dirty) save(folds)
}

export function isFolded(folds: Folds, selectedPath: ReadonlySet<string>, node: CanvasNode) {
  return !selectedPath.has(node.id) && (folds.branches[node.id] ?? outletFolded(folds, node))
}

export function indexBranches(turns: CanvasNode[]) {
  const children = new Map<string | null, CanvasNode[]>()
  for (const n of turns) {
    const siblings = children.get(n.parentId)
    if (siblings) siblings.push(n)
    else children.set(n.parentId, [n])
  }
  // Count entire subtrees once, including branches already folded further down.
  const ordered = [...(children.get(null) || [])]
  const counts = new Map<string, Record<Direction, number>>()
  for (let i = 0; i < ordered.length; i++)
    for (const child of children.get(ordered[i].id) || []) ordered.push(child)
  for (let i = ordered.length - 1; i >= 0; i--) {
    const turn = ordered[i]
    if (!turn.parentId) continue
    const parent = counts.get(turn.parentId) || { card: 0, quote: 0 }
    const nested = counts.get(turn.id)
    parent[directionOf(turn)] += 1 + (nested ? nested.card + nested.quote : 0)
    counts.set(turn.parentId, parent)
  }
  return { children, counts }
}

export function visibleBranches(children: Map<string | null, CanvasNode[]>, folds: Folds, path: ReadonlySet<string>) {
  const visible = new Set<string>()
  const pending = [...(children.get(null) || [])]
  while (pending.length) {
    const n = pending.pop()!
    visible.add(n.id)
    for (const child of children.get(n.id) || [])
      if (!isFolded(folds, path, child)) pending.push(child)
  }
  return visible
}
