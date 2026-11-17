const fs = require('node:fs'),
  assert = require('node:assert/strict'),
  { chromium } = require('playwright-core')
;(async () => {
  const b = await chromium.launch({
      executablePath:
        process.env.DSH_QA_BROWSER ||
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    }),
    p = await b.newPage({ viewport: { width: 1800, height: 1100 }, colorScheme: 'dark' })
  let errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  try {
    await p.goto(
      fs
        .readFileSync(
          process.env.DSH_QA_LOG || process.env.TEMP + '/study-tree-native-qa.log',
          'utf8',
        )
        .match(/http:\/\/[^\s]+/)[0],
    )
    await p.waitForTimeout(800)
    await p.keyboard.press('Escape')
    const start = async (text) => {
      await p.getByText('新会话', { exact: true }).first().click()
      await p.getByRole('button', { name: '以学习画布开始', exact: true }).click()
      await p.locator('[data-composer-input][contenteditable="true"]').first().fill(text)
      await p.keyboard.press('Enter')
      await p.locator('.st-card').waitFor()
    }
    await start('工具流式验收 ' + Date.now())
    await p.waitForTimeout(250)
    const card = p.locator('.st-card'),
      flow = card.locator('.st-turn-flow'),
      rect = await card.boundingBox(),
      handle = await card.elementHandle()
    assert.equal(Math.round(rect.width), 640)
    assert.equal(Math.round(rect.height), 360)
    await flow.getByText(/第一段已经到达/).waitFor()
    assert.equal(await card.locator('.st-generating').count(), 1)
    assert.equal(await card.locator('[data-composer-input]').count(), 0)
    assert.equal(await card.locator('.st-md').count(), 0)
    const first = await flow.innerText()
    await flow.getByText(/第二段正在追加/).waitFor()
    assert.notEqual(await flow.innerText(), first)
    assert.deepEqual(await card.boundingBox(), rect)
    assert.ok(await handle.evaluate((e) => e.isConnected))
    console.log(
      'incremental native stream before end; 640x360 stable; no next editor/fallback parser',
    )
    await card.locator('[data-composer-input][contenteditable="true"]').waitFor({ timeout: 20000 })
    assert.equal(await card.locator('.st-generating').count(), 0)
    assert.equal((await flow.innerText()).split('第一段已经到达').length - 1, 1)
    const control = flow.locator('button[data-turn-process]')
    assert.equal(await control.isEnabled(), true)
    const tool = flow.locator('[data-chat-flow-kind="tool-call"]')
    await control.click()
    assert.equal(await control.getAttribute('aria-expanded'), 'false')
    assert.ok((await tool.boundingBox()).height < 1)
    assert.ok((await flow.innerText()).includes('第三段是最终结果'))
    assert.deepEqual(await card.boundingBox(), rect)
    await p.screenshot({ path: process.env.TEMP + '/study-native-process-folded.png' })
    await control.click()
    assert.equal(await control.getAttribute('aria-expanded'), 'true')
    assert.ok((await tool.boundingBox()).height > 1)
    console.log(
      'native duration control folds process only, answer/card geometry retained; toggle works',
    )
    const paragraph = flow.getByText('第三段是最终结果。本轮结束后才显示继续提问输入框。', {
      exact: true,
    })
    await paragraph.evaluate((e) => {
      const r = new Range()
      r.selectNodeContents(e)
      const s = getSelection()
      s.removeAllRanges()
      s.addRange(r)
      e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 650, clientY: 600 }))
    })
    await p.locator('.st-quote-popover [data-composer-input][contenteditable="true"]').waitFor()
    assert.ok(await p.evaluate(() => CSS.highlights.has('study-tree-quote')))
    await p.locator('.st-quote-popover [data-composer-input]').focus()
    assert.ok(await p.evaluate(() => CSS.highlights.has('study-tree-quote')))
    await p.keyboard.press('Escape')
    console.log('native answer quote opens original editor and preserves highlight')

    const root = p.locator('.st-card').first()
    await root.getByText('我会先检查真实文件，再继续说明。', { exact: true }).evaluate(e => {
      const range = new Range()
      range.selectNodeContents(e)
      const selected = getSelection()
      selected.removeAllRanges()
      selected.addRange(range)
      e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 650, clientY: 600 }))
    })
    const quoteEditor = p.locator('.st-quote-popover [data-composer-input]')
    await quoteEditor.waitFor()
    await quoteEditor.press('End')
    await quoteEditor.pressSequentially('请展开这句话')
    await quoteEditor.press('Enter')
    await p.locator('.st-card .st-quote').waitFor()
    await root.locator('button[data-turn-process]').dispatchEvent('click')
    assert.equal(await root.locator('button[data-turn-process]').getAttribute('aria-expanded'), 'false')
    await p.locator('.st-card .st-quote').dispatchEvent('click')
    await p.waitForTimeout(300)
    assert.equal(await root.locator('button[data-turn-process]').getAttribute('aria-expanded'), 'true')
    assert.ok(await p.evaluate(() => CSS.highlights.has('study-tree-source')))
    console.log('quoted child returns to source and reveals the collapsed process')
    await start('中断流式验收 ' + Date.now())
    await p
      .locator('.st-card .st-turn-flow')
      .getByText(/第一段已经到达/)
      .waitFor()
    await p.getByRole('button', { name: '停止当前回答', exact: true }).click()
    await p
      .locator('.st-card [data-composer-input][contenteditable="true"]')
      .waitFor({ timeout: 15000 })
    assert.ok((await p.locator('.st-card .st-turn-flow').innerText()).includes('已停止'))
    assert.equal(await p.locator('.st-card').count(), 1)
    assert.deepEqual(errors, [])
    console.log('stop targets active run and preserves streamed partial; PASS')
  } catch (e) {
    console.log(
      'ERRS',
      errors.map((s) => s.slice(0, 500)),
    )
    console.log((await p.locator('body').innerText()).slice(-2200))
    await p.screenshot({ path: process.env.TEMP + '/study-turn-acceptance-failure.png' })
    throw e
  } finally {
    await b.close()
  }
})().catch((e) => {
  console.error(e.message.replace(/http\S+/g, '[url]'))
  process.exitCode = 1
})
