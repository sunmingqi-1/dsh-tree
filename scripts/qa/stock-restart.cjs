const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { zstdDecompressSync } = require('node:zlib')
const { chromium } = require('playwright-core')

const checkpoint = 'QA_COMPACT_CHECKPOINT'
function readSession(sessionId) {
  const root = process.env.DSH_QA_SESSIONS
  const file = fs.readdirSync(root, { recursive: true }).find(file =>
    path.basename(path.dirname(file)) === sessionId && /session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(file))
  assert.ok(file, '找不到会话日志 ' + sessionId)
  const bytes = fs.readFileSync(path.join(root, file))
  if (!file.endsWith('.zstd')) return bytes.toString().trim().split('\n').map(JSON.parse)
  const frames = []
  for (let offset = 0; offset < bytes.length;) {
    const { buffer, engine } = zstdDecompressSync(bytes.subarray(offset), { info: true })
    assert.ok(engine.bytesWritten > 0)
    frames.push(buffer)
    offset += engine.bytesWritten
  }
  return Buffer.concat(frames).toString().trim().split('\n').map(JSON.parse)
}

function assertCompacted(sessionId) {
  const rows = readSession(sessionId).map(event => event.type === 'plugin:study-tree/replacement' && event.ignorable
    ? { ...event.data, seq: event.seq } : event)
  const start = rows.find(row => row.type === 'compaction/start')
  const summary = rows.find(row => row.type === 'compaction/summary')
  const replace = rows.find(row => row.type === 'user/message' && row.surfaceOp?.op === 'replace')
  const end = rows.find(row => row.type === 'compaction/end')
  assert.ok(start && summary && replace && end, '压缩事务未完整写入会话')
  assert.ok(start.seq < summary.seq && summary.seq < replace.seq && replace.seq < end.seq)
  assert.equal(start.data.turn, null)
  assert.equal(start.data.compactionId, end.data.compactionId)
  assert.equal(start.data.compactionId, summary.data.compactionId)
  assert.ok(!('error' in end.data))
  assert.ok(summary.data.shadowedSeqs.length > 0)
  assert.ok(JSON.stringify(summary.data.summary).includes(checkpoint))
  assert.ok(JSON.stringify(replace.data.content).includes(checkpoint))
}

// Run "seed", fully stop and restart the isolated host, then run "restore".
// A fresh browser in each phase leaves only DSH's on-disk records available.
async function run() {
  const phase = process.argv[2]
  assert.ok(['seed', 'restore'].includes(phase), '需要 seed 或 restore')
  const stateFile = path.join(process.env.DSH_QA_OUTPUT, 'stock-restart.json')
  const log = fs.readFileSync(process.env.DSH_QA_LOG, 'utf8')
  const endpoint = new URL(log.match(/http:\/\/\S+/)[0])
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))
  const browser = await chromium.launch({
    executablePath: process.env.DSH_QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(endpoint.href)
    const newSession = page.getByText('新会话', { exact: true }).first()
    await newSession.waitFor()
    await page.keyboard.press('Escape')
    const input = '[data-composer-input][contenteditable=true]'
    const reader = page.locator('[data-slot="main.conversation"]')
    const session = reader.locator('[data-conversation-session]').first()
    const card = page.locator('.st-card.active')
    const cardInput = card.locator(input)
    const answer = /第三段是最终结果/
    const send = async (editor, text) => {
      await editor.fill(text)
      await editor.press('Enter')
    }
    const selectNode = async text => {
      await page.locator('.st-tree-title').and(page.getByTitle(text, { exact: true })).click()
      await card.locator('.st-question').filter({ hasText: text }).waitFor()
      await cardInput.waitFor()
    }
    const askFrom = async (from, text) => {
      await selectNode(from)
      await send(cardInput, text)
      await card.locator('.st-question').filter({ hasText: text }).waitFor()
      await cardInput.waitFor()
    }
    const requests = () => fs.readFileSync(path.join(process.env.DSH_QA_OUTPUT, 'native-requests.jsonl'), 'utf8').trim().split('\n')
    const checkRequest = (text, included, excluded) => {
      const line = requests().findLast(line => line.includes(text))
      assert.ok(line, '找不到发给模型的问题 ' + text)
      for (const item of included) assert.ok(line.includes(item), '请求缺少 ' + item)
      for (const item of excluded) assert.ok(!line.includes(item), '请求混入 ' + item)
    }
    if (phase === 'seed') {
      const suffix = Date.now()
      const data = { ordinary: '普通对话 ' + suffix, root: '重启根节点 ' + suffix, child: '重启子节点 ' + suffix }
      await newSession.click()
      await send(page.locator(input).first(), data.ordinary)
      await reader.getByText(answer).first().waitFor()
      data.ordinaryId = await session.getAttribute('data-conversation-session')
      assert.ok(data.ordinaryId)
      assert.equal(await card.count(), 0)
      await newSession.click()
      await page.getByRole('button', { name: '以学习画布开始' }).click()
      await send(page.locator(input).first(), data.root)
      await cardInput.waitFor()
      data.treeId = await session.getAttribute('data-conversation-session')
      assert.ok(data.treeId)
      assert.notEqual(data.ordinaryId, data.treeId)
      await send(cardInput, data.child)
      await card.locator('.st-question').filter({ hasText: data.child }).waitFor()
      await cardInput.waitFor()
      // Tree inputs protect against running session-wide commands. Exercise the same
      // public commands/execute endpoint an authenticated native client would use.
      const reply = await page.evaluate(async sessionId => {
        const method = 'commands/execute'
        const response = await fetch('api/' + method, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', method, rpcId: crypto.randomUUID(),
            payload: { args: { agentId: sessionId, line: '/compact', submittedAttachments: [] } } }),
        })
        return (await response.json()).result
      }, data.treeId)
      assert.equal(reply.ok, true, JSON.stringify(reply))
      assert.equal(reply.value?.result.kind, 'success', JSON.stringify(reply))
      assert.match(reply.value.result.text, /Compacted \d+ history items/)
      assertCompacted(data.treeId)
      const summaryRequest = requests().findLast(line => line.includes('acting as a compaction engine'))
      assert.ok(summaryRequest?.includes(data.root) && summaryRequest.includes(data.child))
      data.sibling = '压缩前根节点分支 ' + suffix
      data.descendant = '继承压缩摘要 ' + suffix
      await askFrom(data.root, data.sibling)
      checkRequest(data.sibling, [data.root], [checkpoint, data.child])
      await askFrom(data.child, data.descendant)
      checkRequest(data.descendant, [checkpoint], [data.root, data.child, data.sibling])
      fs.writeFileSync(stateFile, JSON.stringify(data))
      console.log('真实 /compact 已写入 summary、replace 与 end。A→C 保留压缩前的 A，B→D 使用 B 的摘要。')
    } else {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      await selectNode(data.child)
      assert.equal(await session.getAttribute('data-conversation-session'), data.treeId)
      const text = await reader.innerText()
      assert.ok(text.includes(data.root) && text.includes(data.child))
      assert.ok(!text.includes(data.ordinary))
      assertCompacted(data.treeId)
      await selectNode(data.descendant)
      const pathText = await reader.innerText()
      for (const turn of [data.root, data.child, data.descendant]) assert.ok(pathText.includes(turn))
      assert.ok(!pathText.includes(data.sibling))
      const afterRestart = '重启后从 B 追问 ' + Date.now()
      await askFrom(data.child, afterRestart)
      checkRequest(afterRestart, [checkpoint], [data.root, data.child, data.sibling, data.descendant])
      await selectNode(data.root)
      assert.ok(!(await reader.innerText()).includes(data.child))
      await page.locator(`[data-row-key="session:${data.ordinaryId}"]`).click()
      await reader.getByText(data.ordinary, { exact: true }).first().waitFor()
      await reader.getByText(answer).first().waitFor()
      assert.equal(await session.getAttribute('data-conversation-session'), data.ordinaryId)
      assert.equal(await card.count(), 0)
      assert.ok(!(await reader.innerText()).includes(data.root))
      console.log('重启恢复了同一棵学习树与父子路径，普通会话保留了原有的独立对话。')
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
}

run().catch(error => {
  console.error(error.message.replace(/http\S+/g, '[url]'))
  process.exitCode = 1
})
