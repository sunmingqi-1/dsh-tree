import test from 'node:test'
import assert from 'node:assert/strict'
import { arrange, extendDown, moveBranches } from '../src/client/layout.ts'
import { DEFAULT_CARD_SIZE } from '../src/client/cardSize.ts'
import { adaptLayout } from '../src/client/adaptive.ts'
import { isQuoteBranch } from '../src/client/tree.ts'
import { indexBranches, readFolds, visibleBranches } from '../src/client/branchFolds.ts'

const tree = [
  { id: 'root', parentId: null },
  { id: 'a', parentId: 'root' },
  { id: 'b', parentId: 'root' },
  { id: 'aa', parentId: 'a' },
]
const sizes = {
  root: { width: 340, height: 260 },
  a: { width: 340, height: 180 },
  b: { width: 340, height: 450 },
  aa: { width: 340, height: 220 },
}

test('尚未测量的卡片也能独立向下排列，布局不会改写尺寸缓存', () => {
  const positions = arrange(tree)
  assert.ok(positions.a.y > positions.root.y)
  assert.equal(positions.a.y, positions.b.y)
  assert.notEqual(positions.a.x, positions.b.x)
  const before = structuredClone(sizes)
  arrange(tree, sizes)
  assert.deepEqual(sizes, before)
})

test('向下布局使用真实高度，同级并列，自动布局可重复得到相同位置', () => {
  const positions = arrange(tree, sizes)
  assert.deepEqual(positions.root, { x: 0, y: 0 })
  assert.equal(positions.a.y, positions.b.y)
  assert.ok(Math.abs(positions.a.x - positions.b.x) >= 340)
  for (const node of tree.filter((node) => node.parentId)) {
    assert.ok(positions[node.id].y >= positions[node.parentId].y + sizes[node.parentId].height)
  }
  assert.deepEqual(arrange(tree, sizes), positions)
  assert.deepEqual(arrange([], sizes), {})
})

test('新增追问向下放置，并排避让，保留原来的手动位置', () => {
  const stored = { root: { x: 85, y: 120 }, a: { x: 85, y: 468 } }
  const positions = extendDown(tree, stored, sizes)
  assert.deepEqual(positions.root, stored.root)
  assert.deepEqual(positions.a, stored.a)
  assert.equal(positions.b.y, positions.a.y)
  assert.ok(positions.b.x >= positions.a.x + sizes.a.width)
  assert.ok(positions.aa.y >= positions.a.y + sizes.a.height)
  assert.equal(extendDown(tree, positions, sizes), positions)
})

test('划词分支向右，卡片内附带引文仍向下，混合子树自动布局无重叠', () => {
  const anchor = { text: '原文' }
  const mixed = tree.map(n => ({ ...n, anchor, branchKind: n.id === 'b' ? 'quote' : 'card' }))
  mixed.push({ id: 'bb', parentId: 'b', anchor, branchKind: 'quote' })
  assert.equal(isQuoteBranch({ anchor }), true)
  assert.equal(isQuoteBranch(mixed[1]), false)
  for (const pos of [arrange(mixed, sizes), extendDown(mixed, {}, sizes)]) {
    assert.ok(pos.b.x >= pos.root.x + sizes.root.width)
    assert.ok(pos.a.y >= pos.root.y + sizes.root.height)
    assert.ok(pos.bb.x >= pos.b.x + sizes.b.width)
    for (const [i, n] of mixed.entries()) for (const other of mixed.slice(i + 1)) {
      const p = pos[n.id], q = pos[other.id]
      const s = sizes[n.id] || DEFAULT_CARD_SIZE, t = sizes[other.id] || DEFAULT_CARD_SIZE
      assert.ok(p.x + s.width <= q.x || q.x + t.width <= p.x || p.y + s.height <= q.y || q.y + t.height <= p.y)
    }
  }
})

test('两个出口分别统计所有后代，定位深层节点只展开路径经过的出口', () => {
  const mixed = tree.map(n => ({ ...n, branchKind: n.id === 'b' || n.id === 'aa' ? 'quote' : 'card' }))
  const { children, counts } = indexBranches(mixed.slice().reverse())
  assert.deepEqual(counts.get('root'), { card: 2, quote: 1 })
  assert.deepEqual(counts.get('a'), { card: 0, quote: 1 })
  const visible = (folds, path = []) => [...visibleBranches(children, folds, new Set(path.map(n => n.id)))].sort()
  assert.deepEqual(visible(readFolds('{"root":"quote"}')), ['a', 'aa', 'root'])
  assert.deepEqual(visible(readFolds('{"root":"card"}')), ['b', 'root'])
  const saved = readFolds('{"root":true,"a":"quote","aa":false}')
  assert.deepEqual(visible(saved), ['root'])
  assert.deepEqual(visible(saved, [mixed[0], mixed[1]]), ['a', 'root'])
  assert.deepEqual(visible(saved, [mixed[0], mixed[1], mixed[3]]), ['a', 'aa', 'root'])
  assert.deepEqual(visible(saved, [mixed[0], mixed[2]]), ['b', 'root'])
})

test('定位隐藏的后代只打开祖先路径，同一出口的兄弟服从各自的折叠设置', () => {
  const turns = [...tree, { id: 'c', parentId: 'root' }]
  const { children } = indexBranches(turns)
  const folds = readFolds(JSON.stringify({ version: 2, outlets: { root: 'card' }, branches: { b: false, aa: true } }))
  const shown = ids => [...visibleBranches(children, folds, new Set(ids))].sort()
  assert.deepEqual(shown(['root']), ['b', 'root'])
  assert.deepEqual(shown(['root', 'a']), ['a', 'b', 'root'])
  assert.deepEqual(shown(['root', 'a', 'aa']), ['a', 'aa', 'b', 'root'])
})

test('收起的后代跟随可见父卡移动，展开时让出已被其他卡片占用的原位', () => {
  const { children } = indexBranches(tree)
  const stored = { root: { x: 0, y: 0 }, a: { x: 0, y: 420 }, aa: { x: 0, y: 800 }, b: { x: 900, y: 420 } }
  const pinned = new Set(['root', 'a', 'b'])
  const moved = moveBranches(children, stored, pinned, {
    root: stored.root, a: { x: 120, y: 420 }, b: { x: 120, y: 800 },
  })
  assert.deepEqual(moved.aa, moved.b)
  assert.deepEqual(extendDown(tree.filter(n => pinned.has(n.id)), moved, sizes, pinned), moved)
  const opened = extendDown(tree, moved, sizes, pinned)
  for (const id of pinned) assert.deepEqual(opened[id], moved[id])
  assert.ok(opened.aa.x >= opened.b.x + sizes.b.width + 48)
  assert.equal(opened.aa.y, moved.aa.y)
  assert.equal(extendDown(tree, opened, sizes, new Set()), opened)
})

test('普通追问在父卡下方紧邻排列，右侧深分支不把整条主线推到远处', () => {
  const mixed = tree.map(n => ({ ...n, branchKind: n.id === 'a' ? 'quote' : 'card' }))
  const positions = arrange(mixed, sizes)
  assert.equal(positions.b.y, sizes.root.height + 88)
  assert.ok(positions.a.x >= sizes.root.width + 48)
})

test('隐藏的划词分支不占位，重新展开时向下避让，孙节点保留相对位置', () => {
  const mixed = [
    { id: 'r', parentId: null }, { id: 'q', parentId: 'r', branchKind: 'quote' },
    { id: 'qq', parentId: 'q', branchKind: 'quote' }, { id: 'c', parentId: 'r' },
  ]
  const { children } = indexBranches(mixed)
  const step = DEFAULT_CARD_SIZE.width + 80
  const start = { r: { x: 0, y: 0 }, q: { x: step, y: 0 }, qq: { x: 2 * step, y: 0 }, c: { x: 0, y: DEFAULT_CARD_SIZE.height + 100 } }
  const pinned = new Set(['r', 'c'])
  const moved = moveBranches(children, start, pinned, { r: { x: 10, y: 10 }, c: { x: step + 10, y: 10 } })
  const open = extendDown(mixed.slice().reverse(), moved, {}, pinned)
  assert.deepEqual(open.c, moved.c)
  assert.equal(open.q.x, open.c.x)
  assert.ok(open.q.y >= open.c.y + DEFAULT_CARD_SIZE.height + 48)
  assert.deepEqual(open.qq, { x: open.q.x + step, y: open.q.y })
})

test('长回答展开为下方节点让位，保持列坐标并避免连续后代重叠', () => {
  const stored = arrange(tree, sizes)
  const grown = { ...sizes, root: { width: 340, height: 1600 } }
  const base = Object.fromEntries(tree.map(n => [n.id, { ...stored[n.id], ...sizes[n.id] }]))
  const positions = adaptLayout(base, 'root', { ...stored.root, ...grown.root })
  for (const node of tree) {
    assert.equal(positions[node.id].x, stored[node.id].x)
    assert.ok(positions[node.id].y >= stored[node.id].y)
    if (node.parentId)
      assert.ok(positions[node.id].y >= positions[node.parentId].y + grown[node.parentId].height)
  }
  assert.deepEqual(positions.root, stored.root)
  const settled = Object.fromEntries(tree.map(n => [n.id, { ...positions[n.id], ...grown[n.id] }]))
  assert.deepEqual(adaptLayout(settled, 'root', settled.root), positions)
  assert.deepEqual(adaptLayout(settled, 'missing', settled.root), positions)
})
