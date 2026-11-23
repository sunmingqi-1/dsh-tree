import test from 'node:test'
import assert from 'node:assert/strict'
import { adaptLayout, gestureLayout, NODE_GAP } from '../src/client/adaptive.ts'

const rect = (x, y, width = 100, height = 80) => ({ x, y, width, height })
function separated(a, b) {
  return a.x + a.width + NODE_GAP <= b.x + 1e-6 || b.x + b.width + NODE_GAP <= a.x + 1e-6
    || a.y + a.height + NODE_GAP <= b.y + 1e-6 || b.y + b.height + NODE_GAP <= a.y + 1e-6
}
function verify(base, positions, activeId, next, sizes = {}) {
  const all = Object.entries(positions).map(([id, point]) => [id, { ...base[id], ...sizes[id], ...point, ...id === activeId ? next : {} }])
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++)
    assert.ok(separated(all[i][1], all[j][1]), `${all[i][0]} 与 ${all[j][0]} 间距不足`)
  assert.deepEqual(positions[activeId], { x: next.x, y: next.y })
}

for (const [name, neighbor, next, axis, sign] of [
  ['右', rect(160, 0), rect(70, 0), 'x', 1],
  ['左', rect(-160, 0), rect(-70, 0), 'x', -1],
  ['下', rect(0, 140), rect(0, 70), 'y', 1],
  ['上', rect(0, -140), rect(0, -70), 'y', -1],
]) test(`向${name}拖动时邻居同步让位，正在拖动的卡片保持鼠标位置`, () => {
  const base = { a: rect(0, 0), b: neighbor, remote: rect(1500, 1500) }
  const result = adaptLayout(base, 'a', next)
  verify(base, result, 'a', next)
  assert.ok((result.b[axis] - neighbor[axis]) * sign > 0)
  assert.deepEqual(result.remote, { x: 1500, y: 1500 })
})

test('快速拖动跨过整张邻居卡片仍按原方向连锁推开，不交换顺序', () => {
  const base = { a: rect(0, 0), b: rect(160, 0), c: rect(320, 0), remote: rect(-900, 600) }
  const next = rect(500, 0), result = adaptLayout(base, 'a', next)
  verify(base, result, 'a', next)
  assert.ok(result.b.x > next.x && result.c.x > result.b.x)
  assert.deepEqual(result.remote, { x: -900, y: 600 })
})

test('右下角扩大和左上角扩大分别向邻居方向避让', () => {
  for (const [base, next] of [
    [{ a: rect(0, 0), b: rect(160, 0), c: rect(0, 140) }, rect(0, 0, 280, 220)],
    [{ a: rect(0, 0), b: rect(-160, 0), c: rect(0, -140) }, rect(-180, -140, 280, 220)],
  ]) verify(base, adaptLayout(base, 'a', next), 'a', next)
})

test('缩小只牵引原本相邻的卡片及其邻居，保留间距，远处布局不变', () => {
  const base = { a: rect(0, 0, 260, 160), b: rect(332, 0), c: rect(504, 0), d: rect(0, 240), remote: rect(1600, 1600) }
  const next = rect(0, 0, 120, 80), result = adaptLayout(base, 'a', next)
  verify(base, result, 'a', next)
  assert.equal(result.b.x, 192)
  assert.equal(result.c.x, 364)
  assert.equal(result.d.y, 160)
  assert.deepEqual(result.remote, { x: 1600, y: 1600 })
})

test('同一手势扩大后退回原尺寸，节点恢复初始布局且无累计位移', () => {
  const base = { a: rect(0, 0), b: rect(160, 0), c: rect(320, 0) }, before = structuredClone(base)
  const grown = adaptLayout(base, 'a', rect(0, 0, 400, 80))
  assert.ok(grown.c.x > base.c.x)
  assert.deepEqual(adaptLayout(base, 'a', base.a), { a: { x: 0, y: 0 }, b: { x: 160, y: 0 }, c: { x: 320, y: 0 } })
  assert.deepEqual(base, before)
})

test('其他节点流式增长后的真实尺寸也参与碰撞，不改变拖动节点尺寸', () => {
  const base = { a: rect(0, 0), b: rect(160, 0), c: rect(320, 0) }
  const sizes = { b: { width: 320, height: 100 } }, next = rect(60, 0)
  verify(base, adaptLayout(base, 'a', next, sizes), 'a', next, sizes)
})

test('大图的局部推挤与全图求解一致，往返拖动、跨过多张卡和缩小都保留间距', () => {
  const base = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [String(i), rect(i % 16 * 165, Math.floor(i / 16) * 140)]))
  const source = base['85'], solve = gestureLayout(base, '85')
  for (const [dx, dy, width, height] of [[-40, 0, 100, 80], [650, 120, 140, 130], [0, -250, 100, 80], [0, 0, 64, 50], [0, 0, 100, 80]]) {
    const next = rect(source.x + dx, source.y + dy, width, height)
    const moved = solve(next)
    const positions = Object.fromEntries(Object.entries(base).map(([id, r]) => [id, moved[id] || { x: r.x, y: r.y }]))
    assert.deepEqual(positions, adaptLayout(base, '85', next))
  }
})

test('修复已有重叠时确定性结束，没有 NaN 或互相推回的循环', () => {
  const base = Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['n' + i, rect(0, 0)]))
  const result = adaptLayout(base, 'n0', base.n0)
  verify(base, result, 'n0', base.n0)
  assert.deepEqual(adaptLayout(base, 'n0', base.n0), result)
})

test('负坐标、跨空间分区和不同卡片尺寸下，斜向移动及缩放仍不重叠', () => {
  const base = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i),
    rect(i % 10 * 680 - 3400, Math.floor(i / 10) * 500 - 2500, 560 + i % 3 * 20, 380),
  ]))
  const active = base['44']
  for (const [dx, dy, width, height] of [[1200, 700, 1200, 780], [-900, -900, 700, 500], [80, 30, 420, 240]]) {
    const next = rect(active.x + dx, active.y + dy, width, height)
    verify(base, adaptLayout(base, '44', next), '44', next)
  }
})
