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
    await p.getByText('新会话', { exact: true }).first().click()
    await p.getByRole('button', { name: '以学习画布开始', exact: true }).click()
    const run = Date.now()
    const root = '提问流程起点 ' + run
    const followup = '卡片提问验收 ' + run
    const rootInput = p.locator('[data-composer-input][contenteditable="true"]').first()
    await rootInput.fill(root)
    await rootInput.press('Enter')
    const input = p.locator('.st-card.active [data-composer-input][contenteditable="true"]')
    await input.fill(followup)
    await input.press('Enter')
    const panel = p.locator('.st-native-interaction [data-question-key]')
    await panel.waitFor({ timeout: 20000 })
    assert.equal(await p.locator('[data-question-key]').count(), 1)
    assert.equal(await p.locator('.st-card [data-composer-input]').count(), 0)
    const handle = await panel.elementHandle()
    await panel.getByText('整体架构', { exact: true }).click()
    await p.locator('.st-tree-title').filter({ hasText: root }).click()
    await p.getByRole('button', { name: '从此处分支追问' }).waitFor()
    assert.equal(await p.locator('[data-question-key]:visible').count(), 0)
    await p.locator('.st-tree-title').filter({ hasText: followup }).click()
    await panel.waitFor()
    assert.ok(await panel.evaluate((node, previous) => node === previous, handle))
    const submit = panel.getByRole('button', { name: '提交', exact: true })
    await submit.waitFor()
    const rect = await submit.boundingBox(),
      cardRect = await p.locator('.st-card.active').boundingBox()
    assert.ok(
      rect.y >= cardRect.y && rect.y + rect.height <= cardRect.y + cardRect.height,
      'submit must fit card',
    )
    await p.getByRole('button', { name: '收起对话', exact: true }).click()
    await p.waitForTimeout(200)
    assert.ok(await handle.evaluate((e) => e.isConnected))
    assert.equal(await p.locator('[data-question-key]').count(), 1)
    await p.getByRole('button', { name: '显示对话', exact: true }).click()
    assert.ok(await handle.evaluate((e) => e.isConnected))
    console.log(
      'one native form, original instance/draft retained while hiding reader; submit visible',
    )
    await p.screenshot({ path: process.env.TEMP + '/study-question-acceptance-dark.png' })
    await p.emulateMedia({ colorScheme: 'light' })
    await p.screenshot({ path: process.env.TEMP + '/study-question-acceptance-light.png' })
    await submit.click()
    await p.locator('.st-card .st-generating').waitFor({ state: 'detached', timeout: 25000 })
    await input.waitFor()
    assert.equal(await p.locator('.st-card').count(), 2)
    assert.equal(await p.locator('.st-native-interaction').count(), 0)
    assert.ok((await p.locator('.st-card.active .st-turn-flow').innerText()).includes('第三段是最终结果'))
    assert.deepEqual(errors, [])
    console.log(
      'answer submitted in card, real Agent resumes, no extra study node, composer restored; PASS',
    )
  } catch (e) {
    console.log(
      'ERRS',
      errors.map((s) => s.slice(0, 360)),
    )
    console.log((await p.locator('body').innerText()).slice(-2400))
    await p.screenshot({ path: process.env.TEMP + '/study-question-acceptance-failure.png' })
    throw e
  } finally {
    await b.close()
  }
})().catch((e) => {
  console.error(e.message.replace(/http\S+/g, '[url]'))
  process.exitCode = 1
})
