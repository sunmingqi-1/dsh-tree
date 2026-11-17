import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const output = await build({ entryPoints: [fileURLToPath(new URL('../src/client/nativeDrafts.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false })
const { NativeDrafts, nativeQuestion, quoteText } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'))
const tick = () => new Promise(resolve => setImmediate(resolve))
const storage = new Map()
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }
test.beforeEach(() => storage.clear())

function fixture() {
  const parent = { id: 'root', treeId: 'root', sessionId: 'source', endSeq: 3 }
  const bindings = new Map(), forks = [], opened = [], watched = []
  let held = 0
  function binding(id, entries = []) {
    const listeners = new Set(), inputListeners = new Set()
    const state = { phase: 'plain', draft: '', attachmentIds: [] }
    const input = {
      state: { getSnapshot: () => state, subscribe: fn => { inputListeners.add(fn); return () => inputListeners.delete(fn) } },
      insertQuote: text => { state.draft = quoteText(text) + ' ' },
      setDraft: text => { state.draft = typeof text === 'string' ? text : text.text },
      get draftSnapshot() { return { text: state.draft, references: [] } },
      addAttachments: ids => { state.attachmentIds = [...state.attachmentIds, ...ids] },
      removeAttachment: id => { state.attachmentIds = state.attachmentIds.filter(item => item !== id) },
    }
    const result = { ctx: { id }, input, session: { loadThrough: async () => {}, getSnapshot: () => ({ pendingSubmissions: [] }) }, eventSource: {
      getSnapshot: () => ({ entries }), subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    }, add(event) { entries.push({ event }); for (const fn of listeners) fn() }, notify() { for (const fn of listeners) fn() } }
    bindings.set(id, result); return result
  }
  binding('source', [{ event: { type: 'user/message', seq: 1 } }, { event: { type: 'turn/end', seq: 3 } }])
  const retain = id => { held++; let released = false; return { sessionId: id, ready: Promise.resolve(bindings.get(id)), release() { assert.equal(released, false); released = true; held-- } } }
  const study = { nodes: [], active: parent.id, emit() {}, watch: n => watched.push(n), open: id => opened.push(id), failSave: false,
    async save(node) { await Promise.resolve(); if (study.failSave) throw Error('offline'); study.nodes.push(node); return node },
    ctx: {
      sessions: {
        list: { getSnapshot: () => ({ byId: Object.fromEntries([...bindings.keys()].map(id => [id, {}])) }) },
        retain,
        async using(id, _, fn) { const ref = retain(id); try { return await fn(ref) } finally { ref.release() } },
        async fork(options) { forks.push(options); const id = 'draft-' + forks.length; binding(id, bindings.get(options.sessionId).eventSource.getSnapshot().entries.filter(row => row.event.seq <= options.atSeq)); return id },
      }, conversation: { input: { for: ctx => bindings.get(ctx.id).input } },
    },
  }
  const drafts = new NativeDrafts(study)
  const mount = (kind = 'card', anchor = null) => {
    let reference
    const request = { parent, kind, anchor }
    const stop = drafts.mount(request, ref => { reference = ref }, error => { throw Error(error) })
    return { stop, request, reference: () => reference, binding: () => bindings.get(reference.sessionId) }
  }
  return { study, drafts, parent, bindings, forks, opened, watched, mount, held: () => held }
}

test('卡片草稿从父轮结束处准备，重复挂载复用未发送的分支并释放引用', async () => {
  const f = fixture(), first = f.mount(); await tick()
  assert.deepEqual(f.forks, [{ sessionId: 'source', atSeq: 3 }])
  first.stop(); assert.equal(f.held(), 0)
  const second = f.mount(); await tick()
  assert.equal(second.reference().sessionId, first.reference().sessionId)
  assert.equal(f.forks.length, 1)
  second.stop(); assert.equal(f.held(), 0)
})

test('卡片和划词编辑器使用不同会话，不共享 Lexical root 或草稿', async () => {
  const f = fixture(), card = f.mount(), anchor = { text: '工具', start: 0, prefix: '', suffix: '' }
  await tick(); card.binding().input.setDraft('卡片草稿')
  const quote = f.mount('quote', anchor); await tick()
  assert.notEqual(card.reference().sessionId, quote.reference().sessionId)
  assert.equal(card.binding().input.state.getSnapshot().draft, '卡片草稿')
  assert.match(quote.binding().input.state.getSnapshot().draft, /> 工具/)
  card.stop(); quote.stop(); assert.equal(f.held(), 0)
})

test('预备划词输入后，反复更换选区不再创建或释放会话，也不刷新全局目录', async () => {
  const f = fixture(), card = f.mount()
  await tick()
  const stopWarm = f.drafts.warmQuote(f.parent)
  await tick()
  const forks = f.forks.length, held = f.held()
  let globalUpdates = 0
  f.study.emit = () => { globalUpdates++ }
  const a = { text: '模型', start: 0, prefix: '', suffix: '' }
  const b = { text: '工具', start: 8, prefix: '', suffix: '' }
  const first = f.mount('quote', a)
  await tick()
  const id = first.reference().sessionId
  first.binding().input.setDraft(quoteText(a.text) + '\n\n还没发送的问题')
  first.binding().input.addAttachments(['file-a'])
  first.stop()
  const second = f.mount('quote', b)
  await tick()
  assert.equal(second.reference().sessionId, id)
  assert.equal(second.binding().input.state.getSnapshot().draft.includes('还没发送的问题'), false)
  assert.match(second.binding().input.state.getSnapshot().draft, /> 工具/)
  assert.deepEqual(second.binding().input.state.getSnapshot().attachmentIds, [])
  second.stop()
  const restored = f.mount('quote', a)
  await tick()
  assert.match(restored.binding().input.state.getSnapshot().draft, /还没发送的问题/)
  assert.deepEqual(restored.binding().input.state.getSnapshot().attachmentIds, ['file-a'])
  restored.stop()
  assert.equal(f.forks.length, forks)
  assert.equal(f.held(), held)
  assert.equal(globalUpdates, 0)
  card.stop(); stopWarm()
  assert.equal(f.held(), 0)
})

test('划词发送尚未接收时，新选区使用另一条草稿通道，后台接收不抢选择', async () => {
  const f = fixture(), stopWarm = f.drafts.warmQuote(f.parent)
  await tick()
  const first = f.mount('quote', { text: '模型', start: 0, prefix: '', suffix: '' })
  await tick()
  const original = first.binding()
  original.input.state.getSnapshot().phase = 'sending'
  first.stop()
  const second = f.mount('quote', { text: '工具', start: 8, prefix: '', suffix: '' })
  await tick()
  assert.notEqual(second.reference().sessionId, first.reference().sessionId)
  original.add({ type: 'user/message', seq: 4, data: { source: { kind: 'user', rpcId: 'first-quote' }, content: [{ type: 'text', text: '> 模型\n\n为什么？' }] } })
  await tick()
  assert.equal(f.study.nodes.length, 1)
  assert.equal(f.study.nodes[0].anchor.text, '模型')
  assert.deepEqual(f.opened, [])
  assert.match(second.binding().input.state.getSnapshot().draft, /> 工具/)
  second.stop(); stopWarm()
  assert.equal(f.held(), 0)
})

test('已被原生 DSH 接受的消息只建一个节点，保留问题与引用来源', async () => {
  const f = fixture(), anchor = { text: '工具\n调用', start: 0, prefix: '', suffix: '' }, q = f.mount('quote', anchor)
  await tick()
  q.binding().add({ type: 'user/message', seq: 4, data: { source: { rpcId: 'accepted' }, content: [{ type: 'text', text: quoteText(anchor.text) + '\n\n为什么？' }] } })
  q.binding().notify(); await tick()
  assert.equal(f.study.nodes.length, 1)
  assert.equal(f.study.nodes[0].question, '为什么？')
  assert.deepEqual(f.study.nodes[0].anchor, anchor)
  assert.equal(f.watched.length, 1); assert.equal(f.opened.length, 1)
  assert.equal(q.request.sent, true)
  q.stop(); assert.equal(f.held(), 0)
})

test('提交过程中切换卡片仍记录问答，完成后不抢走当前选择', async () => {
  const f = fixture(), card = f.mount(); await tick()
  const binding = card.binding(); binding.input.state.getSnapshot().phase = 'sending'
  card.stop(); assert.equal(f.held(), 1)
  binding.add({ type: 'user/message', seq: 4, data: { source: { rpcId: 'background' }, content: [{ type: 'text', text: '异步问题' }] } })
  await tick(); assert.equal(f.study.nodes.length, 1); assert.equal(f.opened.length, 0); assert.equal(f.held(), 0)
})

test('节点写入失败后刷新只恢复记录，不重复发送或创建新的模型请求', async () => {
  const f = fixture(), card = f.mount(); await tick(); f.study.failSave = true
  card.binding().add({ type: 'user/message', seq: 4, data: { source: { rpcId: 'recover' }, content: [{ type: 'text', text: '保留此问答' }] } })
  await tick(); card.stop()
  assert.equal(f.study.nodes.length, 0)
  const pending = JSON.parse(storage.get('dsh-study-tree:native-submissions'))
  assert.equal(Object.keys(pending).length, 1)
  f.study.failSave = false; await f.drafts.recover(); await f.drafts.recover()
  assert.equal(f.study.nodes.length, 1); assert.equal(f.study.nodes[0].id, Object.keys(pending)[0])
  assert.equal(f.forks.length, 1)
})

test('旧版卡片草稿只迁移一次，删除原生引用时不保留失效的引用关系', async () => {
  storage.set('dsh-study-tree:view:v1', JSON.stringify({ drafts: { root: '旧草稿' } }))
  const f = fixture(), card = f.mount(); await tick()
  assert.equal(card.binding().input.state.getSnapshot().draft, '旧草稿')
  card.binding().input.setDraft(''); card.stop()
  const again = f.mount(); await tick(); assert.equal(again.binding().input.state.getSnapshot().draft, ''); again.stop()
  assert.deepEqual(nativeQuestion('独立问题', { text: '原文' }), { question: '独立问题', anchor: null })
})
