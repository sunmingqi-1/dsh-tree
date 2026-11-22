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
  const parent = { logged: true, id: 'root', treeId: 'root', sessionId: 'source', endSeq: 3 }
  const bindings = new Map(), forks = [], opened = [], watched = []
  let held = 0
  function binding(id, entries = []) {
    const listeners = new Set(), inputListeners = new Set()
    const state = { phase: 'plain', draft: '', attachmentIds: [] }
    const input = {
      bindPromptParent(provider) {
        this.parent = provider
        return () => { if (this.parent === provider) this.parent = null }
      },
      state: { getSnapshot: () => state, subscribe: fn => { inputListeners.add(fn); return () => inputListeners.delete(fn) } },
      insertQuote: text => { state.draft += quoteText(text) + ' '; return true },
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
  const study = { nodes: [], active: parent.id, submitted: [], onSubmission(id) { return () => this.submitted.push(id) }, emit() {}, watch: n => watched.push(n), open: id => opened.push(id), failSave: false,
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
  const mount = (kind = 'card', anchor = null, origin = parent) => {
    let reference
    const request = { parent: origin, kind, anchor }
    const stop = drafts.mount(request, ref => { reference = ref }, error => { throw Error(error) })
    return { stop, request, reference: () => reference, binding: () => bindings.get(reference.sessionId) }
  }
  return { study, drafts, parent, bindings, forks, opened, watched, mount, held: () => held }
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
  const prompt = input.parent()
  assert.equal(prompt.parentSeq, 3)
  assert.deepEqual(prompt.metadata.studyTree.anchor, a)
  prompt.onRequest('req-1')
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
  const first = input.parent(), second = input.parent()
  assert.notEqual(first.metadata.studyTree.id, second.metadata.studyTree.id)
  assert.equal(first.parentSeq, second.parentSeq)
  card.binding().add({ type: 'user/message', seq: 9, data: { source: { rpcId: 'another-window' } } })
  assert.deepEqual(f.study.submitted, [])
  f.study.nodes.push({ ...f.parent, boundarySeq: 10 })
  assert.equal(input.parent().parentSeq, 10)
  card.stop()
  assert.equal(input.parent, null)
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
  assert.deepEqual(input.parent().metadata.studyTree.anchor, anchor)
  assert.deepEqual(nativeQuestion('单独问题', anchor), { question: '单独问题', anchor: null })
  card.stop()
})
