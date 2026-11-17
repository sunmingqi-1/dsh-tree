const fs = require('node:fs')
const assert = require('node:assert/strict')
const { chromium } = require('playwright-core')

;(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.DSH_QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  })
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    const log = fs.readFileSync(process.env.DSH_QA_LOG || process.env.TEMP + '/study-tree-native-qa.log', 'utf8')
    await page.goto(log.match(/http:\/\/[^\s]+/)[0])
    await page.waitForTimeout(700)
    await page.keyboard.press('Escape')
    await page.getByText('新会话', { exact: true }).first().click()
    await page.getByRole('button', { name: '以学习画布开始', exact: true }).click()
    const question = '流式刷新验收 ' + Date.now()
    await page.locator('[data-composer-input][contenteditable="true"]').first().fill(question)
    await page.keyboard.press('Enter')
    await page.locator('.st-card .st-turn-flow').getByText(/第一段已经到达/).waitFor()
    await page.reload()
    await page.waitForTimeout(700)
    await page.keyboard.press('Escape')
    await page.locator('.st-tree-title').filter({ hasText: question }).first().click()
    await page.locator('.st-card [data-composer-input][contenteditable="true"]').waitFor({ timeout: 25000 })
    const text = await page.locator('.st-card .st-turn-flow').innerText()
    assert.equal(text.split('第一段已经到达').length - 1, 1)
    assert.ok(text.includes('第三段是最终结果'))
    assert.equal(await page.locator('.st-card').count(), 1)
    assert.deepEqual(errors, [])
    console.log('reload during native stream restores one complete turn without duplicate text; PASS')
  } finally {
    await browser.close()
  }
})().catch(error => {
  console.error(error.message.replace(/http\S+/g, '[url]'))
  process.exitCode = 1
})
