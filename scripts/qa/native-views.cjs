const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright-core')

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.DSH_QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  })
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 }, colorScheme: 'light' })
  const errors = [], failures = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const capture = async name => {
    if (process.env.DSH_QA_OUTPUT)
      await page.screenshot({ path: path.join(process.env.DSH_QA_OUTPUT, name + '.png') })
  }
  try {
    const log = fs.readFileSync(process.env.DSH_QA_LOG, 'utf8')
    await page.goto(log.match(/http:\/\/\S+/)[0])
    await page.keyboard.press('Escape')
    await page.getByText('新会话', { exact: true }).first().click()
    const start = page.getByRole('button', { name: '以学习画布开始', exact: true })
    const input = page.locator('[data-composer-input][contenteditable=true]').first()
    await input.fill('首页草稿保留')
    const editor = await input.elementHandle()
    await start.click()
    await page.waitForFunction(() => {
      const button = document.querySelector('.st-native-start')
      return !button || button.getAttribute('aria-pressed') === 'true'
    })
    if (!await start.isVisible()) failures.push('首页选择学习画布后按钮消失')
    else {
      assert.equal(await start.getAttribute('aria-pressed'), 'true')
      await capture('native-home-selected')
      await start.click()
      assert.equal(await start.getAttribute('aria-pressed'), 'false')
      assert.equal(await input.innerText(), '首页草稿保留')
      assert.ok(await input.evaluate((element, previous) => element === previous, editor))
      await start.click()
    }
    const question = '原生页签验收 QA_LAYOUT_SCALE ' + Date.now()
    await input.fill(question)
    await input.press('Enter')
    const cardInput = page.locator('.st-card.active [data-composer-input][contenteditable=true]')
    await cardInput.waitFor()
    const reader = page.locator('[data-slot="main.conversation"]')
    await reader.locator('.st-path-reader').waitFor()
    await cardInput.fill('切换页签后保留的草稿')
    async function openStats() {
      const tab = reader.getByText('统计', { exact: true })
      if (await tab.isVisible()) await tab.click()
      else {
        await reader.getByRole('button', { name: '更多会话视图', exact: true }).click()
        await page.getByText('统计', { exact: true }).click()
      }
    }
    await openStats()
    const stats = reader.getByRole('table', { name: '统计', exact: true })
    try {
      await stats.waitFor({ timeout: 3000 })
      assert.equal(await reader.locator('.st-path-reader').count(), 0)
      assert.ok(await stats.locator('tbody tr').count() > 0)
    } catch {
      failures.push('右侧切换统计后仍显示聊天，原生统计表未出现')
    }
    await capture('native-statistics')
    await reader.getByText('对话', { exact: true }).click()
    await reader.locator('.st-path-reader').waitFor()
    assert.equal(await cardInput.innerText(), '切换页签后保留的草稿')
    assert.equal(await page.locator('.st-card').count(), 1)
    await page.getByText('新会话', { exact: true }).first().click()
    await start.waitFor()
    assert.deepEqual(errors, [])
    assert.deepEqual(failures, [])
    assert.equal(await start.getAttribute('aria-pressed'), 'false')
    await start.click()
    await start.click()
    await input.fill('取消画布后的普通对话 QA_LAYOUT_SCALE ' + Date.now())
    await input.press('Enter')
    await reader.getByText(/第三段是最终结果/).waitFor()
    assert.equal(await page.locator('.st-card').count(), 0)
    await openStats()
    await stats.waitFor()
    assert.deepEqual(errors, [])
    console.log('首页学习画布可选中及取消且保留草稿；右侧统计与对话正常切换；取消后按普通会话发送及查看统计通过。')
  } catch (error) {
    await capture('native-views-failure')
    throw error
  } finally {
    await browser.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
