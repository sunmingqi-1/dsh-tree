const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium } = require('playwright-core')

async function run() {
  const url = fs.readFileSync(process.env.DSH_QA_LOG, 'utf8').match(/http:\/\/\S+/)[0]
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
  const browser = await chromium.launch({ executablePath: process.env.DSH_QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' })
  try {
    const page = await browser.newPage({ viewport: { width: 1640, height: 1000 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(url)
    await page.keyboard.press('Escape')
    await page.getByText('新会话', { exact: true }).first().click()
    await page.getByRole('button', { name: '以学习画布开始' }).click()
    const prefix = 'QA_LAYOUT_SCALE_' + Date.now() + '_'
    const title = i => prefix + i
    const active = page.locator('.st-card.active')
    const input = '[data-composer-input][contenteditable=true]'
    async function select(i) {
      await page.locator('.st-tree-title[title="' + title(i) + '"]').click()
      await active.locator('.st-question[title="' + title(i) + '"]').waitFor()
    }
    const total = 48
    for (let i = 0; i < total; i++) {
      if (i) await select(Math.floor((i - 1) / 3))
      const editor = i ? active.locator(input) : page.locator(input).first()
      await editor.fill(title(i))
      await editor.press('Enter')
      await active.locator('.st-question[title="' + title(i) + '"]').waitFor()
      await active.locator(input).waitFor()
    }
    await select(0)
    await page.getByRole('button', { name: '自动布局', exact: true }).click()
    await page.getByRole('button', { name: '定位当前节点', exact: true }).click()
    const read = () => page.locator('.st-card').evaluateAll(cards => ({
      cards: cards.length,
      replies: cards.filter(c => c.querySelector('.st-native-turn')).length,
    }))
    await page.waitForFunction(n => document.querySelectorAll('.st-card .st-native-turn').length < n / 2, total)
    const sample = await read()
    assert.equal(sample.cards, total)
    const header = active.locator('.st-card-head')
    await header.hover({ position: { x: 5, y: 3 } })
    await page.mouse.wheel(0, -500)
    await page.waitForFunction(() => {
      const head = document.querySelector('.st-card.active .st-card-head')
      const viewport = head.closest('.react-flow__viewport')
      const scale = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a
      return scale > 1.1 && Math.abs(Number(getComputedStyle(head).zoom) - scale) < 0.001
    })
    const magnified = await page.locator('.st-card-head[style*="--st-header-scale"]').count()
    assert.ok(magnified < total, '放大只应调整视野内的标题')
    await page.getByRole('button', { name: '定位当前节点', exact: true }).click()
    await page.waitForFunction(() => {
      const head = document.querySelector('.st-card.active .st-card-head')
      return Number(getComputedStyle(head).zoom) === 1
    })
    async function drag(dx, dy, steps) {
      const grip = active.locator('.st-kind')
      await grip.hover()
      const box = await grip.boundingBox()
      const x = box.x + box.width / 2, y = box.y + box.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + dx, y + dy, { steps })
      await page.mouse.up()
    }
    const position = () => active.evaluate(card => card.parentElement.style.transform)
    const beforeDrag = await position()
    await drag(20, 100, 32)
    assert.notEqual(await position(), beforeDrag)
    await active.locator('.st-outlet[data-outlet="card"]').click()
    await page.waitForFunction(() => document.querySelectorAll('.st-card').length === 1)
    assert.equal(await active.locator('.st-outlet').innerText(), String(total - 1))
    const before = await position()
    await drag(90, 60, 15)
    assert.notEqual(await position(), before)
    await page.getByRole('button', { name: '展开全部', exact: true }).click()
    await page.waitForFunction(n => document.querySelectorAll('.st-card').length === n, total)
    await page.waitForFunction(() => {
      const root = document.querySelector('.st-card.active').parentElement
      const point = new DOMMatrixReadOnly(getComputedStyle(root).transform)
      return point.e === 0 && point.f === 0
    })
    const boxes = await page.locator('.st-card').evaluateAll(cards => cards.map(card => {
      const { e: x, f: y } = new DOMMatrixReadOnly(getComputedStyle(card.parentElement).transform)
      return { x, y, w: card.offsetWidth, h: card.offsetHeight }
    }))
    for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) {
      assert.ok(a.x + a.w + 47 <= b.x || b.x + b.w + 47 <= a.x || a.y + a.h + 47 <= b.y || b.y + b.h + 47 <= a.y)
    }
    await select(total - 1)
    await active.locator('.st-turn-flow').getByText(/第三段是最终结果/).waitFor()
    assert.deepEqual(errors, [])
    console.log('大树实测：%d 张卡片，根节点附近挂载 %d 份回复；折叠、拖动、展开和远端正文回读通过。', total, sample.replies)
  } finally {
    await browser.close()
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
