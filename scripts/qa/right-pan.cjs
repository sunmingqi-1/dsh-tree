const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium } = require('playwright-core')

;(async () => {
  const browser = await chromium.launch({ executablePath: process.env.DSH_QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' })
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    const log = fs.readFileSync(process.env.DSH_QA_LOG || process.env.TEMP + '/study-tree-right-pan-qa.log', 'utf8')
    await page.goto(log.match(/http:\/\/\S+/)[0])
    await page.keyboard.press('Escape')
    await page.getByText('新会话', { exact: true }).first().click()
    await page.getByRole('button', { name: '以学习画布开始' }).click()
    const initial = page.locator('[data-composer-input][contenteditable=true]').first()
    await initial.fill('右键平移验收 ' + Date.now())
    await initial.press('Enter')
    const input = page.locator('.st-card.active [data-composer-input][contenteditable=true]')
    await input.waitFor()
    const canvas = page.locator('.st .react-flow')
    const viewport = canvas.locator('.react-flow__viewport')
    const read = () => viewport.evaluate(element => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
      return [matrix.e, matrix.f, matrix.a]
    })
    const center = async locator => {
      return locator.evaluate(element => {
        const box = element.getBoundingClientRect()
        const x = Math.round(box.left + box.width / 2)
        const y = Math.round(box.top + box.height / 2)
        if (!element.contains(document.elementFromPoint(x, y))) {
          throw new Error('测试起点被其他元素覆盖: ' + element.className)
        }
        return { x, y }
      })
    }
    const origin = await canvas.boundingBox()
    const empty = { x: Math.round(origin.x + 36), y: Math.round(origin.y + 100) }
    const nextFrame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const drag = async (button, from, dx, dy, whileDragging) => {
      await page.mouse.move(from.x, from.y)
      await page.mouse.down({ button })
      await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 })
      if (whileDragging) {
        await nextFrame()
        await whileDragging()
      }
      await page.mouse.up({ button })
      await nextFrame()
    }
    const before = await read()
    await drag('left', empty, 64, 38)
    assert.deepEqual(await read(), before, '左键拖动空白不平移')
    await page.evaluate(() => {
      window.panMenus = 0
      document.addEventListener('contextmenu', () => { window.panMenus++ })
    })
    await input.fill('保留的输入草稿')
    const card = canvas.locator('.react-flow__node').first()
    const cardPosition = () => card.evaluate(element => element.style.transform)
    const position = await cardPosition()
    for (const [name, point] of [
      ['空白', async () => empty],
      ['卡片标题', () => center(card.locator('.st-card-head'))],
      ['正文', () => center(card.locator('.st-body p').first())],
      ['输入框', () => center(input)],
      ['画布工具栏', () => center(canvas.locator('.st-canvas-tools button').first())],
      ['小地图', () => center(canvas.locator('.st-minimap'))],
      ['画布顶栏', () => center(page.locator('.st-bar'))],
    ]) {
      const [x, y, zoom] = await read()
      const expected = [x + 35, y - 19, zoom]
      await drag('right', await point(), 35, -19, async () => {
        assert.deepEqual(await read(), expected, name + '拖动中跟随鼠标')
      })
      assert.deepEqual(await read(), expected, name + '松手后保持位置')
      assert.equal(await cardPosition(), position, '右键不移动单张卡片')
    }
    assert.equal(await input.innerText(), '保留的输入草稿')
    assert.equal(await page.evaluate(() => window.panMenus), 0, '拖动结束不弹出右键菜单')
    await input.click({ button: 'right' })
    assert.equal(await page.evaluate(() => window.panMenus), 1, '右键单击仍派发菜单事件')
    const beforeCardDrag = await read()
    await drag('left', await center(card.locator('.st-kind')), 30, 25)
    assert.notEqual(await cardPosition(), position, '左键仍可拖动卡片')
    assert.deepEqual(await read(), beforeCardDrag, '拖动卡片不平移画布')
    const [, , zoomBeforeWheel] = await read()
    await page.mouse.move(empty.x, empty.y)
    await page.mouse.wheel(0, -120)
    await page.waitForFunction(previousZoom => {
      const element = document.querySelector('.st .react-flow__viewport')
      return new DOMMatrixReadOnly(getComputedStyle(element).transform).a > previousZoom
    }, zoomBeforeWheel)
    assert.deepEqual(errors, [])
    console.log('右键平移在松手前后均正确，覆盖空白、卡片、输入框、工具栏、小地图和顶栏。右键单击与滚轮缩放正常。')
  } finally {
    await browser.close()
  }
})().catch(error => {
  console.error(error.message.replace(/http\S+/g, '[url]'))
  process.exitCode = 1
})
