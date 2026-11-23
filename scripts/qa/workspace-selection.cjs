const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright-core')

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.DSH_QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  })
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } })
  const errors = [], requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
  })
  page.on('response', async response => {
    const url = new URL(response.url())
    if (!['/api/session/create', '/api/workspace/create'].includes(url.pathname)) return
    try {
      const body = await response.json()
      requests.push({ method: url.pathname, status: response.status(), result: body.result })
    } catch {}
  })
  try {
    const url = fs.readFileSync(process.env.DSH_QA_LOG, 'utf8').match(/http:\/\/\S+/)[0]
    await page.goto(url)
    await page.keyboard.press('Escape')
    await page.getByText('新会话', { exact: true }).first().click()
    async function rpc(method, request) {
      const result = await page.evaluate(async ({ method, request }) => {
        const response = await fetch('/api/' + method, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: { request } } }),
        })
        return (await response.json()).result
      }, { method, request })
      assert.equal(result.ok, true, JSON.stringify(result.error))
      return result.value
    }
    const folder = fs.mkdtempSync(path.join(process.env.DSH_QA_DOCUMENTS, 'workspace-pick-'))
    const first = path.join(folder, 'job-hunting'), second = path.join(folder, 'study-notes')
    for (const dir of [first, second]) fs.mkdirSync(dir)
    const workspace = await rpc('workspace/create', { path: first })
    const other = await rpc('workspace/create', { path: second })
    const picker = page.getByRole('button', { name: '选择工作区', exact: true })
    const input = page.locator('[data-composer-input][contenteditable=true]').first()
    async function choose(name) {
      await picker.click()
      await page.getByRole('menuitem', { name, exact: true }).click()
      await page.waitForFunction(name =>
        document.querySelector('button[aria-label="选择工作区"]')?.textContent.includes(name), name)
      await page.waitForFunction(() =>
        document.querySelector('[data-composer-input]')?.getAttribute('contenteditable') === 'true')
    }
    await input.fill('工作区切换后应保留的草稿')
    await choose('job-hunting')
    assert.equal(await input.innerText(), '工作区切换后应保留的草稿')
    await page.getByRole('button', { name: '以学习画布开始', exact: true }).click()
    await choose('study-notes')
    assert.equal(await input.innerText(), '工作区切换后应保留的草稿')
    assert.equal(await page.getByRole('button', { name: '以学习画布开始' }).getAttribute('aria-pressed'), 'true')
    await rpc('workspace/delete', { workspaceId: other.workspace.workspaceId })
    await page.waitForFunction(() =>
      document.querySelector('button[aria-label="选择工作区"]')?.textContent.includes('选择工作区'))
    await choose('job-hunting')
    assert.equal(await input.innerText(), '工作区切换后应保留的草稿')
    await input.fill('工作区选择验收 QA_LAYOUT_SCALE ' + Date.now())
    await input.press('Enter')
    await page.locator('.st-card.active [data-composer-input]').waitFor()
    await page.getByText('新会话', { exact: true }).first().click()
    await page.waitForFunction(() => !document.querySelector('.st-card'))
    await rpc('workspace/create', { path: second })
    await rpc('workspace/delete', { workspaceId: workspace.workspace.workspaceId })
    await page.waitForFunction(() =>
      document.querySelector('button[aria-label="选择工作区"]')?.textContent.includes('选择工作区'))
    await choose('study-notes')
    if (process.env.DSH_QA_OUTPUT)
      await page.screenshot({ path: path.join(process.env.DSH_QA_OUTPUT, 'workspace-selection.png') })
    assert.deepEqual(errors, [])
    console.log('工作区切换验收通过，覆盖普通首页、学习画布、返回首页、失效工作区重新选择与草稿保留。')
  } catch (error) {
    console.error(JSON.stringify({ errors, requests }, null, 2))
    if (process.env.DSH_QA_OUTPUT)
      await page.screenshot({ path: path.join(process.env.DSH_QA_OUTPUT, 'workspace-selection-failure.png') })
    throw error
  } finally {
    await browser.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
