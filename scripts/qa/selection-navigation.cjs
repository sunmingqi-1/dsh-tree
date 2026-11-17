const fs = require('node:fs')
const assert = require('node:assert/strict')
const { chromium } = require('playwright-core')

;(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.DSH_QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  })
  const page = await browser.newPage({
    viewport: { width: 1800, height: 1100 },
    colorScheme: 'dark',
  })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    const log = fs.readFileSync(
      process.env.DSH_QA_LOG || process.env.TEMP + '/study-tree-native-qa.log',
      'utf8',
    )
    await page.goto(log.match(/http:\/\/\S+/)[0])
    await page.waitForTimeout(600)
    await page.keyboard.press('Escape')
    await page.getByText('新会话', { exact: true }).first().click()
    await page.getByRole('button', { name: '以学习画布开始', exact: true }).click()
    await page
      .locator('[data-composer-input][contenteditable=true]')
      .first()
      .fill('划词导航回归 ' + Date.now())
    await page.keyboard.press('Enter')
    await page.locator('.st-card.active [data-composer-input]').waitFor({ timeout: 20000 })
    await page.waitForTimeout(500)
    const before = await page.evaluate(() => {
      const row = document.querySelector('.st-tree-row')
      const sidebar =
        row.closest('aside') ||
        row.closest('[data-slot="sidebar"]') ||
        row.parentElement.parentElement
      window.selectionProbe = { changes: 0, preparing: 0, incomplete: 0, run: true }
      selectionProbe.observer = new MutationObserver((records) => {
        selectionProbe.changes += records.filter((r) => r.type === 'childList').length
      })
      selectionProbe.observer.observe(sidebar, { childList: true, subtree: true })
      function sample() {
        if (!selectionProbe.run) return
        const popup = document.querySelector('.st-quote-popover')
        if (popup && getComputedStyle(popup).visibility !== 'hidden') {
          if (popup.textContent.includes('正在准备输入框')) selectionProbe.preparing++
          if (!popup.querySelector('[data-composer-input][contenteditable=true]'))
            selectionProbe.incomplete++
        }
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
      return {
        drafts: Object.keys(
          JSON.parse(localStorage.getItem('dsh-study-tree:composer-drafts') || '{}'),
        ).length,
        rows: [...document.querySelectorAll('.st-tree-title')].map((e) => e.textContent),
      }
    })
    const source = page
      .locator('.st-card.active .st-turn-flow')
      .getByText('第三段是最终结果。本轮结束后才显示继续提问输入框。', { exact: true })
    const select = async (index, branch = true) => {
      await source.evaluate((element, offset) => {
        const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()
        const range = new Range()
        range.setStart(node, offset)
        range.setEnd(node, offset + 4)
        const selection = getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        element.dispatchEvent(
          new MouseEvent('mouseup', { bubbles: true, clientX: 600, clientY: 600 }),
        )
      }, index)
      await page.getByRole('toolbar', { name: '选中文字操作' }).waitFor()
      assert.equal(await page.locator('.st-quote-popover').count(), 0)
      if (!branch) return
      await page.getByRole('button', { name: '在分支中提问', exact: true }).click()
      await page.locator('.st-quote-popover [data-composer-input][contenteditable=true]').waitFor()
      assert.ok(await page.evaluate(() => CSS.highlights.has('study-tree-quote')))
    }
    for (let i = 0; i < 3; i++) {
      await select(i)
      const editor = page.locator('.st-quote-popover [data-composer-input]')
      assert.ok((await editor.innerText()).includes('第三段是最终结果'.slice(i, i + 4)))
      await editor.press('End')
      await editor.pressSequentially('问题草稿' + i)
      await page.keyboard.press('Escape')
    }
    await select(0)
    assert.ok(
      (await page.locator('.st-quote-popover [data-composer-input]').innerText()).includes(
        '问题草稿0',
      ),
    )
    await page.screenshot({ path: process.env.TEMP + '/study-selection-popup-complete.png' })
    await page.keyboard.press('Escape')
    const cardInput = page.locator('.st-card.active [data-study-composer="card"] [data-composer-input]')
    await cardInput.fill('卡片原有草稿')
    await cardInput.press('End')
    const cards = await page.locator('.st-card').count()
    await select(2, false)
    await page.locator('.st-card.active').screenshot({ path: process.env.TEMP + '/study-selection-actions.png' })
    await page.getByRole('button', { name: '添加到对话', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.st-card.active [data-study-composer="card"] [data-composer-input]')?.textContent.includes('段是最终'))
    assert.ok((await cardInput.innerText()).includes('卡片原有草稿'))
    assert.equal(await page.locator('.st-card').count(), cards, 'adding a quote must not submit or branch')
    assert.equal(await page.locator('.st-quote-popover').count(), 0)
    assert.ok(await cardInput.evaluate(element => element === document.activeElement))
    assert.ok(await page.evaluate(() => CSS.highlights.has('study-tree-quote')))
    await page.locator('.st-card.active').screenshot({ path: process.env.TEMP + '/study-selection-added.png' })
    const after = await page.evaluate(() => {
      selectionProbe.run = false
      selectionProbe.observer.disconnect()
      return {
        changes: selectionProbe.changes,
        preparing: selectionProbe.preparing,
        incomplete: selectionProbe.incomplete,
        drafts: Object.keys(
          JSON.parse(localStorage.getItem('dsh-study-tree:composer-drafts') || '{}'),
        ).length,
        rows: [...document.querySelectorAll('.st-tree-title')].map((e) => e.textContent),
      }
    })
    assert.equal(after.changes, 0, 'selection must not rebuild sidebar rows')
    assert.equal(after.drafts, before.drafts, 'selection must not create new draft sessions')
    assert.deepEqual(after.rows, before.rows)
    assert.equal(after.preparing, 0, 'no visible gray preparation placeholder')
    assert.equal(after.incomplete, 0, 'popup first appears with its complete native editor')
    assert.deepEqual(errors, [])
    console.log(
      'two selection actions; add-to-card preserves draft/focus/highlight without sending; branch popup complete; zero sidebar mutations/new sessions; PASS',
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error.message.replace(/http\S+/g, '[url]'))
  process.exitCode = 1
})
