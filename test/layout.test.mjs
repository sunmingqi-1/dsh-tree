import test from 'node:test'
import assert from 'node:assert/strict'
import { arrange, extendDown, makeRoom } from '../src/client/layout.ts'

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

test('长回答展开为下方节点让位，保持列坐标并避免连续后代重叠', () => {
  const stored = arrange(tree, sizes)
  const grown = { ...sizes, root: { width: 340, height: 1600 } }
  const positions = makeRoom(tree, stored, grown, 'root')
  for (const node of tree) {
    assert.equal(positions[node.id].x, stored[node.id].x)
    assert.ok(positions[node.id].y >= stored[node.id].y)
    if (node.parentId)
      assert.ok(positions[node.id].y >= positions[node.parentId].y + grown[node.parentId].height)
  }
  assert.deepEqual(positions.root, stored.root)
  assert.equal(makeRoom(tree, positions, grown, 'root'), positions)
  assert.equal(makeRoom(tree, positions, sizes, 'missing'), positions)
})
