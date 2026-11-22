const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { zstdDecompressSync } = require('node:zlib')
const { chromium } = require('playwright-core')

const sessionDirectory = process.env.DSH_QA_SESSIONS

function sessionLogs() {
  return fs.readdirSync(sessionDirectory, { recursive: true })
    .filter(name => /(?:^|[\\/])session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(name))
    .sort()
}

function readQuestions(file) {
  const bytes = fs.readFileSync(path.join(sessionDirectory, file))
  const frames = []
  if (file.endsWith('.zstd')) {
    let offset = 0
    while (offset < bytes.length) {
      // Node decodes one frame per call. DSH appends a frame for each batch.
      const { buffer, engine } = zstdDecompressSync(bytes.subarray(offset), { info: true })
      assert.ok(engine.bytesWritten > 0, 'Zstandard decoder did not advance')
      offset += engine.bytesWritten
      frames.push(buffer)
    }
  } else frames.push(bytes)
  return Buffer.concat(frames).toString('utf8').trim().split('\n')
    .map(line => JSON.parse(line))
    .filter(event => event.type === 'user/message' && event.data.source?.rpcId)
    .map(event => event.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n'))
}

async function waitForLog(sessionId, questions) {
  const find = () => sessionLogs().find(file => path.basename(path.dirname(file)) === sessionId)
  let lastError
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const file = find()
      if (file) {
        assert.deepEqual(readQuestions(file), questions)
        return file
      }
    } catch (error) { lastError = error }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw lastError || new Error('找不到 Session 日志 ' + sessionId)
}

;(async () => {
  const browser = await chromium.launch({ executablePath: process.env.DSH_QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' })
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  try {
    const log = fs.readFileSync(process.env.DSH_QA_LOG || path.join(process.env.TEMP, 'study-tree-native-qa.log'), 'utf8')
    await page.goto(log.match(/http:\/\/\S+/)[0])
    await page.keyboard.press('Escape')
    await page.getByText('新会话', { exact: true }).first().click()
    await page.getByRole('button', { name: '以学习画布开始' }).click()
    const run = Date.now()
    const messages = ['根节点', '同会话续问', '右侧续问', '历史节点另问'].map(name => `${name} ${run}`)
    const editor = scope => page.locator(`${scope} [data-composer-input][contenteditable=true]`)
    const conversation = '[data-slot="main.conversation"]'
    const currentSession = () => page.locator(`${conversation} [data-conversation-session]`).first().getAttribute('data-conversation-session')
    const card = '.st-card.active'
    const activeTitle = page.locator(`${card} .st-question`)
    const waitTitle = text => page.waitForFunction(text => document.querySelector('.st-card.active .st-question')?.textContent === text, text)
    const send = async (input, text) => { await input.fill(text); await input.press('Enter'); await waitTitle(text) }
    const draftForks = () => page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('dsh-study-tree:composer-drafts') || '{}')))
    const rootInput = page.locator('[data-composer-input][contenteditable=true]').first()
    await send(rootInput, messages[0])
    await editor(card).waitFor()
    const rootSession = await currentSession()
    assert.ok(rootSession)
    const rootLog = sessionDirectory ? await waitForLog(rootSession, messages.slice(0, 1)) : null
    const before = rootLog ? sessionLogs() : null
    await send(editor(card), messages[1])
    await editor(card).waitFor()
    assert.equal(await currentSession(), rootSession)
    if (rootLog) {
      assert.equal(await waitForLog(rootSession, messages.slice(0, 2)), rootLog)
      assert.deepEqual(sessionLogs(), before, '卡片续问时不应增加 Session 日志')
    }

    await editor(card).fill(messages[2])
    await page.getByRole('button', { name: '在右侧输入', exact: true }).click()
    const rightInput = editor(conversation)
    assert.equal(await rightInput.innerText(), messages[2])
    assert.equal(await editor(card).count(), 0)
    await rightInput.press('Enter')
    await waitTitle(messages[2])
    await editor(card).waitFor()
    assert.equal(await currentSession(), rootSession)
    assert.deepEqual(await draftForks(), [])
    if (rootLog) {
      assert.equal(await waitForLog(rootSession, messages.slice(0, 3)), rootLog)
      assert.deepEqual(sessionLogs(), before, '右侧续问时不应增加 Session 日志')
    }

    await page.locator('.st-tree-title').filter({ hasText: messages[0] }).click()
    await waitTitle(messages[0])
    await editor(card).waitFor()
    assert.equal(await currentSession(), rootSession)
    assert.deepEqual(await draftForks(), [])
    const shown = await page.locator(`${conversation} [data-chat-turn]:visible`).allTextContents()
    assert.ok(shown.some(text => text.includes(messages[0])))
    assert.ok(shown.every(text => !text.includes(messages[1]) && !text.includes(messages[2])))
    await send(editor(card), messages[3])
    await editor(card).waitFor()
    const branchSession = await currentSession()
    assert.equal(branchSession, rootSession)
    assert.deepEqual(await draftForks(), [])
    if (rootLog) {
      assert.equal(await waitForLog(rootSession, messages), rootLog)
      assert.deepEqual(sessionLogs(), before)
    }
    const branchRows = await page.locator(`${conversation} [data-chat-turn]:visible`).allTextContents()
    assert.ok(branchRows.some(text => text.includes(messages[0])))
    assert.ok(branchRows.some(text => text.includes(messages[3])))
    assert.ok(branchRows.every(text => !text.includes(messages[1]) && !text.includes(messages[2])))
    const requests = fs.readFileSync(path.join(process.env.DSH_QA_OUTPUT || path.join(process.env.TEMP, 'dsh-study-tree-qa'), 'native-requests.jsonl'), 'utf8').split('\n')
    const continuation = requests.findLast(line => line.includes(messages[2]))
    const branch = requests.findLast(line => line.includes(messages[3]))
    assert.ok(continuation.includes(messages[0]) && continuation.includes(messages[1]))
    assert.ok(branch.includes(messages[0]) && !branch.includes(messages[1]) && !branch.includes(messages[2]))
    assert.equal(await activeTitle.textContent(), messages[3])
    assert.deepEqual(errors, [])
    console.log('普通续问和右栏续问复用一个会话，回看历史零 fork，旧节点分支的模型请求排除了后续两轮')
  } finally {
    await browser.close()
  }
})().catch(error => {
  console.error(error.message.replace(/http\S+/g, '[url]'))
  process.exitCode = 1
})
