import test from 'node:test'
import assert from 'node:assert/strict'
import { rasterPolicy, visibleHeaderRaster } from '../src/client/raster.ts'

test('只补偿可见且放大的标题，平移进入视野和卸载时同步观察状态', t => {
  let notify, disconnected = false
  const targets = new Set()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver')
  globalThis.IntersectionObserver = class {
    constructor(callback) { notify = callback }
    observe(header) { targets.add(header) }
    unobserve(header) { targets.delete(header) }
    disconnect() { disconnected = true }
  }
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'IntersectionObserver', descriptor)
    else delete globalThis.IntersectionObserver
  })
  function header() {
    const writes = []
    return { writes, closest: () => null, style: {
      getPropertyValue: () => writes.at(-1) ?? '',
      setProperty: (_, value) => writes.push(value),
    } }
  }
  const raster = visibleHeaderRaster(0.4)
  const a = header(), b = header()
  const removeA = raster.observe(a), removeB = raster.observe(b)
  const visibility = (target, isIntersecting) => notify([{ target, isIntersecting }])
  visibility(a, true)
  raster.settle(1 + Number.EPSILON)
  assert.deepEqual(a.writes, [])
  raster.settle(1.65)
  assert.deepEqual(a.writes, ['1.65'])
  assert.deepEqual(b.writes, [])
  visibility(a, false)
  visibility(b, true)
  assert.deepEqual(b.writes, ['1.65'])
  raster.settle(0.6)
  assert.deepEqual(b.writes, ['1.65', ''])
  assert.deepEqual(a.writes, ['1.65'])
  visibility(a, true)
  assert.deepEqual(a.writes, ['1.65', ''])
  removeA()
  visibility(a, true)
  raster.settle(1.4)
  assert.deepEqual(a.writes, ['1.65', ''])
  removeB()
  assert.equal(targets.size, 0)
  assert.equal(disconnected, true)
})

test('平移复用绘制层，100 次平移更新不重复切换样式', () => {
  let value = 'auto', writes = 0
  const layer = { style: { get willChange() { return value }, set willChange(next) { value = next; writes++ } } }
  const policy = rasterPolicy(() => layer, 1)
  policy.start({ type: 'mousedown' })
  for (let i = 0; i < 100; i++) policy.change({ zoom: 1 })
  policy.end({ zoom: 1 })
  assert.equal(value, 'transform'); assert.equal(writes, 1)
})

test('连续滚轮缩放复用绘制层，不逐帧重绘，停下后恢复清晰绘制', () => {
  let value = 'auto', writes = 0
  const layer = { style: { get willChange() { return value }, set willChange(next) { value = next; writes++ } } }
  const policy = rasterPolicy(() => layer, 0.5)
  policy.start({ type: 'wheel' })
  assert.equal(value, 'transform')
  for (let i = 1; i <= 100; i++) {
    policy.change({ zoom: 0.5 + i / 100 })
    assert.equal(value, 'transform')
  }
  assert.equal(writes, 1)
  policy.end({ zoom: 1.5 })
  assert.equal(value, 'auto'); assert.equal(writes, 2)
  policy.start({ type: 'wheel' }); policy.change({ zoom: 1.4 })
  assert.equal(value, 'transform')
  policy.end({ zoom: 1.4 }); assert.equal(value, 'auto')
})

test('手势从平移变成捏合缩放时保持缓存，只在缩放结束时释放', () => {
  const layer = { style: { willChange: 'auto' } }, policy = rasterPolicy(() => layer, 1)
  policy.start({ type: 'touchstart' }); assert.equal(layer.style.willChange, 'transform')
  policy.change({ zoom: 1.1 }); assert.equal(layer.style.willChange, 'transform')
  policy.end({ zoom: 1.1 }); assert.equal(layer.style.willChange, 'auto')
})

test('按钮/自动布局缩放也在结束后恢复清晰绘制，图层未挂载时安全初始化', () => {
  let layer = null
  const policy = rasterPolicy(() => layer, 1)
  policy.start(null); policy.change({ zoom: 0.6 })
  layer = { style: { willChange: 'transform' } }
  policy.end({ zoom: 1.4 }); assert.equal(layer.style.willChange, 'auto')
})

test('缩放后继续平移不会每帧释放图层，下一次缩放结束仍恢复清晰', () => {
  const layer = { style: { willChange: 'auto' } }, policy = rasterPolicy(() => layer, 1)
  policy.start(null); policy.change({ zoom: 1.4 }); policy.end({ zoom: 1.4 })
  assert.equal(layer.style.willChange, 'auto')
  policy.start({ type: 'mousedown' }); policy.change({ zoom: 1.4 }); policy.end({ zoom: 1.4 })
  assert.equal(layer.style.willChange, 'transform')
  policy.start({ type: 'wheel' }); policy.end({ zoom: 1.6 })
  assert.equal(layer.style.willChange, 'auto')
})

test('标题层只在缩放结束时按最终比例排版，平移和中间帧不触发布局', () => {
  const layer = { style: { willChange: 'auto' } }, refreshed = []
  const policy = rasterPolicy(() => layer, 0.5, zoom => refreshed.push(zoom))
  policy.start({ type: 'wheel' })
  for (let i = 1; i <= 100; i++) policy.change({ zoom: 0.5 + i / 100 })
  assert.deepEqual(refreshed, [])
  policy.end({ zoom: 1.5 })
  assert.deepEqual(refreshed, [1.5])
  policy.start({ type: 'mousedown' }); policy.change({ zoom: 1.5 }); policy.end({ zoom: 1.5 })
  assert.deepEqual(refreshed, [1.5])
  policy.start(null); policy.change({ zoom: 1.2 }); policy.end({ zoom: 1.2 })
  assert.deepEqual(refreshed, [1.5, 1.2])
})

test('小地图程序平移不改变缩放时，保留缓存且不重排标题', () => {
  const layer = { style: { willChange: 'auto' } }, refreshed = []
  const policy = rasterPolicy(() => layer, 1, zoom => refreshed.push(zoom))
  for (let i = 0; i < 100; i++) {
    policy.start(null); policy.change({ zoom: 1 }); policy.end({ zoom: 1 })
  }
  assert.equal(layer.style.willChange, 'transform')
  assert.deepEqual(refreshed, [])
})
