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
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 }, colorScheme: 'light' })
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

    const pick = async (text) => {
      await page.locator('.st-tree-title').filter({ hasText: text }).click()
      await waitTitle(text)
    }
    await pick(messages[0])
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

    await pick(messages[1])
    assert.equal(await currentSession(), rootSession)
    assert.deepEqual(await draftForks(), [])
    const shown = await page.locator(`${conversation} [data-chat-turn]:visible`).allTextContents()
    assert.ok(shown.some(text => text.includes(messages[0])))
    assert.ok(shown.some(text => text.includes(messages[1])))
    assert.ok(shown.every(text => !text.includes(messages[2])))
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
    assert.ok(branchRows.some(text => text.includes(messages[1])))
    assert.ok(branchRows.every(text => !text.includes(messages[2])))
    const requests = fs.readFileSync(path.join(process.env.DSH_QA_OUTPUT || path.join(process.env.TEMP, 'dsh-study-tree-qa'), 'native-requests.jsonl'), 'utf8').split('\n')
    const continuation = requests.findLast(line => line.includes(messages[2]))
    const branch = requests.findLast(line => line.includes(messages[3]))
    assert.ok(continuation.includes(messages[0]) && !continuation.includes(messages[1]))
    assert.ok(branch.includes(messages[0]) && branch.includes(messages[1]) && !branch.includes(messages[2]))
    assert.equal(await activeTitle.textContent(), messages[3])
    assert.deepEqual(errors, [])
    console.log('A→B、A→C、B→D 共享同一日志；C 和 D 的原生阅读与模型输入只包含各自的父链。')

    const activeCard = page.locator(card)
    const fold = (name, count) => activeCard.getByRole('button', { name: name + '（' + count + ' 个节点）', exact: true })
    const surfaces = () => activeCard.evaluate(card => [card, card.querySelector('.st-card-head'), card.querySelector('[data-composer-card]')]
      .map(el => getComputedStyle(el).backgroundColor))
    async function checkCount(count) {
      await page.waitForFunction(n => document.querySelectorAll('.st-card').length === n
        && document.querySelectorAll('.react-flow__edge').length === n - 1
        && document.querySelectorAll('.react-flow__minimap-node').length === n, count)
    }
    async function checkOutlet(handleId) {
      const targetId = await activeCard.locator('..').getAttribute('data-id')
      const edge = page.locator(`.react-flow__edge[data-id="${targetId}"]`)
      // An axis-aligned SVG path can have zero bounding-box width or height.
      await edge.waitFor({ state: 'attached' })
      const distance = await edge.evaluate((element, handleId) => {
        const path = element.querySelector('path.react-flow__edge-path')
        const start = path.getPointAtLength(0).matrixTransform(path.getScreenCTM())
        const handle = document.querySelector(`.st-card:has(.st-question[title^="同会话续问 "]) [data-handleid="${handleId}"]`)
        const rect = handle.getBoundingClientRect()
        return Math.hypot(start.x - rect.left - rect.width / 2, start.y - rect.top - rect.height / 2)
      }, handleId)
      assert.ok(distance < 10, '连线起点应在 ' + handleId + ' 出口，实测偏差 ' + distance)
    }
    await checkOutlet('card')
    await pick(messages[1])
    await editor(card).waitFor()
    const originalColors = await surfaces()
    await activeCard.getByRole('button', { name: '节点颜色 · 未标记' }).click()
    const palette = page.getByRole('group', { name: '选择节点颜色' })
    await palette.waitFor()
    const buttonBox = await activeCard.locator('.st-mark-trigger').boundingBox()
    const paletteBox = await palette.boundingBox()
    assert.ok(paletteBox.x <= buttonBox.x + buttonBox.width && paletteBox.x + paletteBox.width >= buttonBox.x - 1)
    assert.ok(paletteBox.y <= buttonBox.y + buttonBox.height + 14 && paletteBox.y + paletteBox.height >= buttonBox.y - 14)
    if (process.env.DSH_QA_OUTPUT) await page.screenshot({ path: path.join(process.env.DSH_QA_OUTPUT, 'node-mark-palette.png') })
    await palette.getByRole('button', { name: '珊瑚红' }).click()
    await page.waitForSelector('.st-card.active[data-mark="coral"]')
    const markedColors = await surfaces()
    markedColors.forEach((color, i) => assert.notEqual(color, originalColors[i], '标记色应覆盖卡片、标题和输入框'))
    await fold('折叠卡片追问', 1).click()
    await checkCount(3)
    await pick(messages[0])
    await fold('折叠卡片追问', 3).click()
    await checkCount(1)
    assert.equal(await fold('展开卡片追问', 3).innerText(), '3')
    await page.reload()
    await pick(messages[0])
    await checkCount(1)
    await fold('展开卡片追问', 3).click()
    await checkCount(3)
    await pick(messages[1])
    assert.equal(await activeCard.getAttribute('data-mark'), 'coral')
    await fold('展开卡片追问', 1).click()
    await checkCount(4)

    async function askAbout(fragment) {
      await activeCard.locator('.st-turn-flow').getByText(fragment).last().evaluate(element => {
        const range = new Range()
        const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()
        range.setStart(text, 0)
        range.setEnd(text, Math.min(8, text.length))
        const selection = getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      })
      await page.getByRole('button', { name: '在分支中提问', exact: true }).click()
      const quoted = page.locator('.st-quote-popover [data-composer-input]')
      await quoted.press('End')
      await quoted.pressSequentially('再举个例子')
      await quoted.press('Enter')
      await page.waitForSelector('.st-card.active .st-quote')
      await editor(card).waitFor()
    }
    await askAbout(/第三段是最终结果/)
    await checkCount(5)
    await checkOutlet('quote')
    const input = editor(card)
    const composer = activeCard.locator('[data-composer-card]')
    const layout = () => activeCard.evaluate(card => {
      const body = card.querySelector('.st-body')
      const style = getComputedStyle(body)
      const center = selector => {
        const rect = card.querySelector(selector).getBoundingClientRect()
        return rect.top + rect.height / 2
      }
      return {
        width: card.offsetWidth, height: card.offsetHeight,
        readable: body.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
        inlineQuote: Math.abs(center('.st-question') - center('.st-quote')) < 4,
        composer: card.querySelector('[data-composer-card]').offsetHeight,
      }
    })
    await activeCard.locator('.st-card-head [data-turn-process]').waitFor()
    await page.waitForFunction(() => {
      const card = document.querySelector('.st-card.active')
      return card.querySelector('[data-composer-card]')?.offsetHeight <= 42
        && parseFloat(card.style.getPropertyValue('--st-composer-space')) <= 54
    })
    const reading = await layout()
    assert.deepEqual([reading.width, reading.height], [768, 512])
    assert.ok(reading.inlineQuote && reading.readable >= 380, JSON.stringify(reading))
    if (process.env.DSH_QA_OUTPUT) {
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.waitForSelector('body[data-ds-dark-theme]')
      await activeCard.screenshot({ path: path.join(process.env.DSH_QA_OUTPUT, 'reading-card.png') })
      await page.emulateMedia({ colorScheme: 'light' })
    }
    await input.click()
    await page.keyboard.type('draft')
    await input.evaluate(el => el.blur())
    assert.equal(await input.innerText(), 'draft')
    assert.ok(await composer.evaluate(el => el.offsetHeight) > reading.composer)
    await input.click()
    await input.press('ControlOrMeta+a')
    await input.press('Backspace')
    await input.evaluate(el => el.blur())
    await page.waitForFunction(height =>
      document.querySelector('.st-card.active [data-composer-card]')?.offsetHeight === height, reading.composer)
    assert.deepEqual(await activeCard.evaluate(el => [el.offsetWidth, el.offsetHeight]), [reading.width, reading.height])
    console.log('引用卡正文可读高度 ' + reading.readable + 'px，空输入栏 ' + reading.composer + 'px，草稿失焦后仍保留。')
    await page.getByRole('button', { name: '连线方式', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '圆角折线' }).click()
    await page.getByRole('button', { name: '自动布局', exact: true }).click()
    await page.waitForSelector('.react-flow__edge-smoothstep', { state: 'attached' })
    await checkOutlet('quote')
    await page.getByRole('button', { name: '折叠：' + messages[1], exact: true }).click()
    await checkCount(3)
    assert.equal(await activeTitle.textContent(), messages[1])
    const bounds = await activeCard.boundingBox()
    const right = await fold('展开划词分支', 1).boundingBox()
    const bottom = await fold('展开卡片追问', 1).boundingBox()
    assert.ok(right.x > bounds.x + bounds.width && bottom.y > bounds.y + bounds.height)
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForSelector('body[data-ds-dark-theme]')
    assert.notDeepEqual(await surfaces(), markedColors)
    if (process.env.DSH_QA_OUTPUT) {
      const box = await activeCard.boundingBox()
      await page.screenshot({ path: path.join(process.env.DSH_QA_OUTPUT, 'folded-outlets.png'),
        clip: { x: box.x - 10, y: box.y - 10, width: box.width + 65, height: box.height + 50 } })
    }
    await page.emulateMedia({ colorScheme: 'light' })
    await fold('展开卡片追问', 1).click()
    await checkCount(4)
    await page.locator('.st-tree-title').filter({ hasText: messages[3] }).waitFor()
    await page.reload()
    await pick(messages[1])
    await checkCount(4)
    assert.equal(await fold('展开划词分支', 1).innerText(), '1')
    await fold('展开划词分支', 1).click()
    await checkCount(5)
    await fold('折叠卡片追问', 1).click()
    await checkCount(4)
    assert.equal(await page.locator('.st-tree-title').filter({ hasText: messages[3] }).count(), 0)
    await fold('展开卡片追问', 1).click()
    await checkCount(5)
    await pick(messages[3])
    await page.getByRole('button', { name: '查看整棵树', exact: true }).click()
    const parentCard = page.locator('.st-card').filter({ has: page.locator('.st-question', { hasText: messages[1] }) })
    await parentCard.getByRole('button', { name: '折叠划词分支（1 个节点）' }).click()
    await checkCount(4)
    assert.equal(await activeTitle.textContent(), messages[3])
    await pick(messages[1])
    await activeCard.getByRole('button', { name: '节点颜色 · 珊瑚红' }).click()
    await palette.getByRole('button', { name: '清除颜色' }).click()
    await activeCard.getByRole('button', { name: '节点颜色 · 未标记' }).waitFor()
    assert.deepEqual(await surfaces(), originalColors)
    // B still has its quote outlet folded. Hide B as well, then restore both levels.
    await pick(messages[0])
    const overview = () => page.getByRole('button', { name: '查看整棵树', exact: true }).click()
    const inlet = (action, question) => page.getByRole('button', { name: action + '分支：' + question, exact: true })
    await overview()
    await inlet('收起', messages[1]).click()
    await checkCount(2)
    assert.equal(await inlet('展开', messages[1]).innerText(), '3')
    assert.equal(await inlet('收起', messages[2]).count(), 1)
    await inlet('展开', messages[1]).click()
    await checkCount(4)
    await inlet('收起', messages[1]).click()
    await checkCount(2)
    await page.reload()
    await pick(messages[0])
    await checkCount(2)
    assert.equal(await inlet('展开', messages[1]).innerText(), '3')
    const bottomOutlet = activeCard.locator('.st-outlet-group[data-outlet="card"]')
    assert.equal(await bottomOutlet.getByRole('button', { name: '展开分支：' + messages[1], exact: true }).count(), 1)
    await inlet('收起', messages[2]).click()
    await checkCount(1)
    assert.equal(await bottomOutlet.getByRole('button').count(), 1)
    assert.equal(await fold('展开卡片追问', 4).innerText(), '4')
    assert.equal(await page.getByRole('button', { name: /^展开分支：/ }).count(), 0)
    assert.equal(await page.locator('.st-inlet').count(), 0)
    await fold('展开卡片追问', 4).click()
    await checkCount(4)
    await fold('折叠卡片追问', 4).click()
    await checkCount(1)
    const expandAll = page.getByRole('toolbar', { name: '画布工具' }).getByRole('button', { name: '展开全部' })
    assert.match(await expandAll.getAttribute('title'), /4 个隐藏节点/)
    if (process.env.DSH_QA_OUTPUT) {
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.waitForSelector('body[data-ds-dark-theme]')
      await page.getByRole('toolbar', { name: '画布工具' }).screenshot({ path: path.join(process.env.DSH_QA_OUTPUT, 'expand-all-toolbar.png') })
    }
    await expandAll.click()
    await checkCount(5)
    assert.equal(await expandAll.isDisabled(), true)
    assert.equal(await activeTitle.textContent(), messages[0])
    const directory = page.getByRole('tree', { name: '学习主题' }).filter({ has: page.getByTitle(messages[0], { exact: true }) })
    assert.equal(await directory.getByRole('treeitem').count(), 5)
    await page.reload()
    await pick(messages[0])
    await checkCount(5)
    assert.equal(await expandAll.isDisabled(), true)
    await pick(messages[1])
    await askAbout(/第一段已经到达/)
    await checkCount(6)
    await pick(messages[1])
    await overview()
    const quoteInlet = page.getByRole('button', { name: /^收起分支：.* · 第一段/ })
    const quoteCard = page.locator('.st-card').filter({ has: quoteInlet })
    await quoteInlet.hover()
    const beforeFold = await quoteInlet.boundingBox()
    const boundsBeforeFold = await quoteCard.boundingBox()
    assert.ok(beforeFold.x + beforeFold.width <= boundsBeforeFold.x)
    assert.ok(Math.abs(beforeFold.y + beforeFold.height / 2 - boundsBeforeFold.y - boundsBeforeFold.height / 2) < 2)
    await quoteInlet.click()
    await checkCount(5)
    const siblingInlet = page.getByRole('button', { name: /^收起分支：.* · 第三段/ })
    assert.equal(await siblingInlet.count(), 1)
    const rightOutlet = activeCard.locator('.st-outlet-group[data-outlet="quote"]')
    const restore = rightOutlet.getByRole('button', { name: /^展开分支：.* · 第一段/ })
    const box = await restore.boundingBox(), outlet = await rightOutlet.boundingBox()
    assert.ok(Math.abs(box.x - outlet.x) < 10 && Math.abs(box.y - (outlet.y + outlet.height)) < 10)
    await restore.click()
    await checkCount(6)
    await quoteInlet.click()
    await siblingInlet.click()
    await checkCount(4)
    assert.equal(await rightOutlet.getByRole('button').count(), 1)
    assert.equal(await fold('展开划词分支', 2).innerText(), '2')
    assert.equal(await page.getByRole('button', { name: /^展开分支：/ }).count(), 0)
    assert.equal(await page.locator('.st-folded-paths path').count(), 0)
    if (process.env.DSH_QA_OUTPUT) {
      await page.screenshot({ path: path.join(process.env.DSH_QA_OUTPUT, 'folded-quote-branches.png') })
    }
    await fold('展开划词分支', 2).click()
    await checkCount(6)
    await quoteInlet.click()
    await expandAll.click()
    await checkCount(6)
    assert.equal(await currentSession(), rootSession)
    if (rootLog) assert.deepEqual(sessionLogs(), before)
    assert.deepEqual(errors, [])
    console.log('节点标色和嵌套折叠重载后保留，卡片及划词分支使用底部和右侧出口，小地图同步。')
  } catch (error) {
    if (process.env.DSH_QA_OUTPUT) await page.screenshot({ path: path.join(process.env.DSH_QA_OUTPUT, 'session-paths-failure.png') })
    throw error
  } finally {
    await browser.close()
  }
})().catch(error => {
  console.error((error.stack || error.message).replace(/http\S+/g, '[url]'))
  process.exitCode = 1
})
