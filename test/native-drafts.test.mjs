import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { rc5Shell } from './rc5-composer.mjs'

const output = await build({ entryPoints: [fileURLToPath(new URL('../src/client/nativeDrafts.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false })
const { NativeDrafts, nativeQuestion, quoteText } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'))
const tick = () => new Promise(resolve => setImmediate(resolve))
const storage = new Map()
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }
test.beforeEach(() => storage.clear())

function fixture() {
  const parent = { logged: true, id: 'root', treeId: 'root', sessionId: 'source', endSeq: 3 }
  const bindings = new Map(), forks = [], opened = [], watched = []
  const prepared = [], prompts = [], abandoned = []
  let held = 0
  function binding(id, entries = []) {
    const listeners = new Set(), inputListeners = new Set()
    const state = { phase: 'plain', draft: '', attachmentIds: [] }
    const input = {
      state: { getSnapshot: () => state, subscribe: fn => { inputListeners.add(fn); return () => inputListeners.delete(fn) } },
      insertQuote: text => { state.draft += quoteText(text) + ' '; return true },
      setDraft: text => { state.draft = typeof text === 'string' ? text : text.text },
      get draftSnapshot() { return { text: state.draft, references: [] } },
      addAttachments: ids => { state.attachmentIds = [...state.attachmentIds, ...ids] },
      removeAttachment: id => { state.attachmentIds = state.attachmentIds.filter(item => item !== id) },
    }
    const conversation = rc5Shell(input, state, () => { for (const fn of inputListeners) fn() })
    const result = { ctx: { id }, input, conversation, session: {
      loadThrough: async () => {}, getSnapshot: () => ({ pendingSubmissions: [] }),
      beginSubmission() {
        const requestId = crypto.randomUUID()
        return { requestId, abandon() { abandoned.push(requestId) } }
      },
      async prompt(...args) { prompts.push(args); return { ok: true } },
    }, eventSource: {
      getSnapshot: () => ({ entries }), subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    }, add(event) { entries.push({ event }); for (const fn of listeners) fn() }, notify() { for (const fn of listeners) fn() } }
    bindings.set(id, result); return result
  }
  binding('source', [{ event: { type: 'user/message', seq: 1 } }, { event: { type: 'turn/end', seq: 3 } }])
  const retain = id => { held++; let released = false; return { sessionId: id, ready: Promise.resolve(bindings.get(id)), release() { assert.equal(released, false); released = true; held-- } } }
  const study = { nodes: [], active: parent.id, submitted: [], onSubmission(id) { return () => this.submitted.push(id) }, emit() {}, watch: n => watched.push(n), open: id => opened.push(id), failSave: false,
    async call(method, { request }) { assert.equal(method, 'preparePrompt'); prepared.push(request) }, forgetSubmission() {},
    async save(node) { await Promise.resolve(); if (study.failSave) throw Error('offline'); study.nodes.push(node); return node },
    ctx: {
      sessions: {
        list: { getSnapshot: () => ({ byId: Object.fromEntries([...bindings.keys()].map(id => [id, {}])) }) },
        retain,
        async using(id, _, fn) { const ref = retain(id); try { return await fn(ref) } finally { ref.release() } },
        async fork(options) { forks.push(options); const id = 'draft-' + forks.length; binding(id, bindings.get(options.sessionId).eventSource.getSnapshot().entries.filter(row => row.event.seq <= options.atSeq)); return id },
      }, conversation: bindings.get('source').conversation,
    },
  }
  const drafts = new NativeDrafts(study)
  const mount = (kind = 'card', anchor = null, origin = parent) => {
    let reference
    const request = { parent: origin, kind, anchor }
    const stop = drafts.mount(request, ref => { reference = ref }, error => { throw Error(error) })
    return { stop, request, reference: () => reference, binding: () => bindings.get(reference.sessionId) }
  }
  return { study, drafts, parent, bindings, forks, opened, watched, prepared, prompts, abandoned, mount, held: () => held }
}

test('卡片与划词共用一个原生会话，按父节点、选区恢复草稿和附件', async () => {
  const f = fixture(), card = f.mount()
  await tick()
  const input = card.binding().input
  input.setDraft('卡片草稿')
  input.addAttachments(['card-file'])
  card.stop()
  const a = { text: '模型', start: 0, prefix: '', suffix: '' }
  const quote = f.mount('quote', a)
  await tick()
  assert.equal(quote.reference().sessionId, 'source')
  assert.match(input.state.getSnapshot().draft, /> 模型/)
  assert.deepEqual(input.state.getSnapshot().attachmentIds, [])
  await input.submit('steer')
  const [prompt] = f.prepared
  assert.equal(prompt.parentSeq, 3)
  assert.deepEqual(prompt.metadata.studyTree.anchor, a)
  assert.equal(prompt.metadata.studyTree.branchKind, 'quote')
  assert.equal(prompt.requestId, f.prompts[0][3])
  assert.equal(prompt.sessionId, 'source')
  assert.equal(f.prompts[0][1], 'queue')
  assert.equal(f.prompts[0].length, 4)
  assert.deepEqual(f.study.submitted, [prompt.metadata.studyTree.id])
  input.setDraft('引用草稿')
  input.addAttachments(['quote-file'])
  quote.stop()
  const again = f.mount()
  await tick()
  assert.equal(input.state.getSnapshot().draft, '卡片草稿')
  assert.deepEqual(input.state.getSnapshot().attachmentIds, ['card-file'])
  again.stop()
  const quoteAgain = f.mount('quote', a)
  await tick()
  assert.equal(input.state.getSnapshot().draft, '引用草稿')
  assert.deepEqual(input.state.getSnapshot().attachmentIds, ['quote-file'])
  quoteAgain.stop()
  assert.equal(f.held(), 0)
  assert.deepEqual(f.forks, [])
})

test('从同一父节点二次发送生成新的标识，其他窗口的事件不会被认领', async () => {
  const f = fixture(), card = f.mount()
  await tick()
  const input = card.binding().input
  card.binding().add({ type: 'user/message', seq: 9, data: { source: { rpcId: 'another-window' } } })
  assert.deepEqual(f.study.submitted, [])
  input.setDraft('第一次')
  await input.submit('queue')
  input.setDraft('第二次')
  await input.submit('queue')
  const [first, second] = f.prepared
  assert.notEqual(first.metadata.studyTree.id, second.metadata.studyTree.id)
  assert.equal(first.parentSeq, second.parentSeq)
  f.study.nodes.push({ ...f.parent, boundarySeq: 10 })
  input.setDraft('第三次')
  await input.submit('queue')
  assert.equal(f.prepared[2].parentSeq, 10)
  card.stop()
  await assert.rejects(input.submit('queue'), /unexpected ordinary message/)
  assert.deepEqual(f.forks, [])
})

test('添加到对话保留现有草稿与附件，删除引用后不生成失效链接', async () => {
  const f = fixture(), card = f.mount()
  await tick()
  const input = card.binding().input
  input.setDraft('问题 ')
  input.addAttachments(['file'])
  const anchor = { text: '工具', start: 2, prefix: 'a', suffix: 'b' }
  await f.drafts.addToCard(f.parent, anchor)
  assert.equal(input.state.getSnapshot().draft, '问题 > 工具 ')
  assert.deepEqual(input.state.getSnapshot().attachmentIds, ['file'])
  await input.submit('queue')
  assert.deepEqual(f.prepared[0].metadata.studyTree.anchor, anchor)
  assert.equal(f.prepared[0].metadata.studyTree.branchKind, 'card')
  assert.deepEqual(f.prompts[0][0], [{ type: 'file', receiptId: 'file' }, { type: 'text', text: '问题 > 工具 ' }])
  assert.deepEqual(nativeQuestion('单独问题', anchor), { question: '单独问题', anchor: null })
  card.stop()
})

test('准备分支时切换卡片，失败不发送原生请求，原卡片保留文字和附件供重试', async () => {
  const f = fixture(), card = f.mount()
  await tick()
  const input = card.binding().input
  input.setDraft('待重试的问题')
  input.addAttachments(['receipt'])
  const prepare = f.study.call
  let reject
  f.study.call = () => new Promise((_, no) => { reject = no })
  const flight = input.submit('enter')
  card.stop()
  const other = f.mount('card', null, { ...f.parent, id: 'other', endSeq: 7 })
  assert.equal(other.reference(), undefined)
  assert.deepEqual(f.prompts, [])
  assert.deepEqual(f.study.submitted, [])
  reject(Error('父节点已过期'))
  await assert.rejects(flight, /父节点已过期/)
  await tick()
  assert.equal(other.reference().sessionId, 'source')
  assert.equal(input.draftSnapshot.text, '')
  assert.deepEqual(f.prompts, [])
  assert.equal(f.abandoned.length, 1)
  other.stop()
  const retry = f.mount()
  await tick()
  assert.equal(input.draftSnapshot.text, '待重试的问题')
  assert.deepEqual(input.state.getSnapshot().attachmentIds, ['receipt'])
  f.study.call = prepare
  await input.submit('queue')
  assert.equal(f.prompts.length, 1)
  assert.equal(f.prepared[0].requestId, f.prompts[0][3])
  assert.notEqual(f.prepared[0].requestId, f.abandoned[0])
  assert.equal(f.prepared[0].parentSeq, 3)
  retry.stop()
})

test('原生 prompt 拒绝后保留草稿，插件卸载时恢复普通会话输入', async () => {
  const f = fixture()
  const { input, session } = f.bindings.get('source')
  input.setDraft('普通对话草稿')
  const ordinary = input.submit, card = f.mount()
  await tick()
  input.setDraft('树上的问题')
  input.addAttachments(['file'])
  session.prompt = async () => ({ ok: false, error: { message: '宿主拒绝问题' } })
  await assert.rejects(input.submit('queue'), /宿主拒绝问题/)
  assert.equal(input.draftSnapshot.text, '树上的问题')
  assert.deepEqual(input.state.getSnapshot().attachmentIds, ['file'])
  assert.deepEqual(f.abandoned, [f.prepared[0].requestId])
  f.drafts.dispose()
  assert.equal(input.submit, ordinary)
  assert.equal(input.draftSnapshot.text, '普通对话草稿')
  assert.deepEqual(input.state.getSnapshot().attachmentIds, [])
  card.stop()
  assert.equal(f.held(), 0)
})

test('准备期间取消发送不再投递，斜杠命令的键盘和菜单入口均保留输入', async () => {
  const f = fixture(), binding = f.bindings.get('source'), input = binding.input
  const directory = { ensureReady: async () => {}, resolve: (_, name) => name === 'goal' }
  const notices = [], picks = []
  const triggers = {
    menu: { getSnapshot: () => ({ groups: [{ source: 'command', status: 'ready', items: [{ name: 'goal' }, { name: 'client' }] }] }) },
    pick: (_, index) => picks.push(index), adjudicate: async line => line,
  }
  binding.ctx.get = () => ({ directory })
  input.deps.inputTriggers = () => triggers
  input.notify = (_, message) => notices.push(message)
  const card = f.mount()
  await tick()
  input.setDraft('/compact')
  await input.submit('queue')
  assert.equal(input.draftSnapshot.text, '/compact')
  assert.deepEqual(f.prepared, [])
  await assert.rejects(triggers.adjudicate('/goal 目标'), /普通对话/)
  assert.equal(await triggers.adjudicate('/tmp/file'), '/tmp/file')
  triggers.pick('command', 0)
  triggers.pick('command', 1)
  assert.deepEqual(picks, [1])
  assert.equal(notices.length, 2)
  const abort = new AbortController()
  const send = f.study.ctx.conversation.sendSession
  f.study.ctx.conversation.sendSession = (target, text, files, mode, _, accept) =>
    send(target, text, files, mode, abort.signal, accept)
  let prepared
  f.study.call = () => new Promise(resolve => { prepared = resolve })
  input.setDraft('取消测试')
  const flight = input.submit('queue')
  abort.abort(Error('会话已关闭'))
  prepared()
  await assert.rejects(flight, /会话已关闭/)
  assert.deepEqual(f.prompts, [])
  assert.equal(input.draftSnapshot.text, '取消测试')
  card.stop()
  triggers.pick('command', 0)
  assert.deepEqual(picks, [1, 0])
})
