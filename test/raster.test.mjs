import test from 'node:test'
import assert from 'node:assert/strict'
import { rasterPolicy } from '../src/client/raster.ts'

test('平移复用绘制层，100 次平移更新不重复切换样式', () => {
  let value = 'auto', writes = 0
  const layer = { style: { get willChange() { return value }, set willChange(next) { value = next; writes++ } } }
  const policy = rasterPolicy(() => layer, 1)
  policy.start({ type: 'mousedown' })
  for (let i = 0; i < 100; i++) policy.change({ zoom: 1 })
  policy.end({ zoom: 1 })
  assert.equal(value, 'transform'); assert.equal(writes, 1)
})

test('滚轮放大前取消固定位图提示，结束后保持当前比例重新绘制', () => {
  const layer = { style: { willChange: 'transform' } }, policy = rasterPolicy(() => layer, 0.5)
  policy.start({ type: 'wheel' }); assert.equal(layer.style.willChange, 'auto')
  policy.change({ zoom: 1.2 }); policy.end({ zoom: 1.65 })
  assert.equal(layer.style.willChange, 'auto')
})

test('手势从平移变成捏合缩放时，检测实际缩放值并取消固定缓存', () => {
  const layer = { style: { willChange: 'auto' } }, policy = rasterPolicy(() => layer, 1)
  policy.start({ type: 'touchstart' }); assert.equal(layer.style.willChange, 'transform')
  policy.change({ zoom: 1.1 }); assert.equal(layer.style.willChange, 'auto')
})

test('按钮/自动布局缩放采用清晰度模式，图层未挂载时也可安全初始化', () => {
  let layer = null
  const policy = rasterPolicy(() => layer, 1)
  policy.start(null); policy.change({ zoom: 0.6 })
  layer = { style: { willChange: 'transform' } }
  policy.end({ zoom: 1.4 }); assert.equal(layer.style.willChange, 'auto')
})
