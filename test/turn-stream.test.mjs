import test from 'node:test'
import assert from 'node:assert/strict'
import { readTurn } from '../src/client/tree.ts'

// SessionEventLikeEntry fixtures follow session-controller's durable/transient
// contract. Only live chunks carry an attemptId; settlements use turn + step.
function recording(turn = 1, requestId = 'request') {
  const entries = []
  let seq = 0
  let transient = 0
  const add = (type, data, surfaceOp) => {
    transient = 0
    entries.push({ type: 'event', event: {
      type, seq: seq++, time: 1000 + seq, data,
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
    } })
  }
  const live = (step, attemptId, chunk) => entries.push({
    type: 'transient',
    event: {
      type: 'assistant/live-chunk', seq: seq - 1 / (++transient + 1), time: 1000 + seq,
      data: { turn, step, attemptId, chunk },
    },
  })
  const message = (step, content, interrupted = false, surfaceOp = 'append') => add('assistant/message', {
    turn, step, stream: [],
    message: { id: `message-${seq}`, role: 'assistant', content,
      source: { kind: 'model', provider: 'test', model: 'test' } },
    ...(interrupted ? { interrupted: true } : {}),
  }, surfaceOp)
  add('turn/start', { turn })
  add('user/message', { id: 'prompt', role: 'user', content: [{ type: 'text', text: '问题' }],
    source: { kind: 'user', rpcId: requestId } }, 'append')
  add('step/start', { turn, step: 1 })
  return { entries, add, live, message }
}

const text = value => ({ type: 'text', text: value })
const delta = (value, index = 0) => ({ type: 'text-delta', index, text: value })

test('流式正文逐段可读，最终消息与 transient 共存或退休时都只出现一次', () => {
  const r = recording()
  r.live(1, 'session:1', delta('先确认'))
  assert.equal(readTurn(r.entries, 'request').answer, '先确认')
  r.live(1, 'session:1', delta('文件结构。'))
  assert.equal(readTurn(r.entries, 'request').answer, '先确认文件结构。')
  r.message(1, [text('先确认文件结构。')])
  assert.equal(readTurn(r.entries, 'request').answer, '先确认文件结构。')
  r.add('step/end', { turn: 1, step: 1 })
  const retired = r.entries.filter(entry => entry.type !== 'transient')
  assert.equal(readTurn(retired, 'request').answer, '先确认文件结构。')
})

test('多个 Step 保留前文，当前 Step 的最终文本替换其 partial 而不重复', () => {
  const r = recording()
  r.live(1, 'session:1', delta('检查中'))
  r.message(1, [text('已检查文件。'), { type: 'tool-call', id: 'call', name: 'read', arguments: '{}' }])
  r.add('step/end', { turn: 1, step: 1 })
  r.add('step/start', { turn: 1, step: 2 })
  r.live(2, 'session:2', delta('据此'))
  assert.equal(readTurn(r.entries, 'request').answer, '已检查文件。\n\n据此')
  r.message(2, [text('据此得出结论。')])
  r.add('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(readTurn(r.entries, 'request'), {
    answer: '已检查文件。\n\n据此得出结论。', endSeq: 7, reason: { kind: 'completed' },
  })
})

test('block-end 可单独提供正文并覆盖相同索引的增量，交错块按索引排序', () => {
  const r = recording()
  r.live(1, 'session:1', delta('后段', 2))
  r.live(1, 'session:1', { type: 'reasoning-delta', index: 1, text: '内部分析' })
  r.live(1, 'session:1', delta('前', 0))
  r.live(1, 'session:1', { type: 'block-end', index: 0, block: text('前段。') })
  r.live(1, 'session:1', { type: 'block-end', index: 3, block: text('仅有完整块。') })
  assert.equal(readTurn(r.entries, 'request').answer, '前段。后段仅有完整块。')
})

test('失败 attempt 的临时正文退休，重试仅重置当前 Step', () => {
  const r = recording()
  r.message(1, [text('上一步。')])
  r.add('step/end', { turn: 1, step: 1 })
  r.add('step/start', { turn: 1, step: 2 })
  r.live(2, 'session:2', delta('失败草稿'))
  r.add('assistant/attempt', { turn: 1, step: 2, stream: [
    { type: 'text-chunks', time0: 1000, index: 0, dt: [], texts: ['失败草稿'] },
  ] })
  assert.equal(readTurn(r.entries, 'request').answer, '上一步。')
  r.add('llm/retry', { retryId: 'retry', turn: 1, step: 2, provider: 'test', mode: 'normal',
    policyKey: 'test', retry: 1, maxRetries: 3, delayMs: 100, failure: { code: 'TEST_ERROR', message: 'test' } })
  r.add('llm/retry-started', { retryId: 'retry', turn: 1, step: 2, retry: 1 })
  r.live(2, 'session:3', delta('新答案'))
  r.message(2, [text('新答案')])
  assert.equal(readTurn(r.entries, 'request').answer, '上一步。\n\n新答案')
})

test('llm/retry 清空当前 partial，不依赖上一 attempt 的 transient 是否已退休', () => {
  const r = recording()
  r.live(1, 'session:1', delta('失败草稿'))
  r.add('llm/retry', { retryId: 'retry', turn: 1, step: 1, provider: 'test', mode: 'always',
    policyKey: 'test', retry: 1, delayMs: 100, failure: { code: 'TEST_ERROR', message: 'test' } })
  assert.equal(readTurn(r.entries, 'request').answer, '')
  r.live(1, 'session:2', delta('重试正文'))
  assert.equal(readTurn(r.entries, 'request').answer, '重试正文')
})

test('同 Step 的 attemptId 改变时不拼接上一次输出', () => {
  const r = recording()
  r.live(1, 'session:1', delta('旧草稿'))
  r.live(1, 'session:2', delta('新草稿'))
  assert.equal(readTurn(r.entries, 'request').answer, '新草稿')
})

test('停止后保留中断正文并返回真实结束原因和序号', () => {
  const r = recording()
  r.live(1, 'session:1', delta('尚未'))
  r.message(1, [text('尚未完成')], true)
  r.add('turn/end', { turn: 1, reason: { kind: 'aborted' } })
  assert.deepEqual(readTurn(r.entries, 'request'), {
    answer: '尚未完成', endSeq: 4, reason: { kind: 'aborted' },
  })
})

test('旧轮缺少 turn/end 时仍在下一轮截止，即使后续源重复 rpcId', () => {
  const r = recording()
  r.message(1, [text('本轮')])
  r.add('turn/start', { turn: 2 })
  r.add('user/message', { id: 'next', role: 'user', content: [],
    source: { kind: 'retry', rpcId: 'request' } }, 'append')
  r.add('assistant/message', { turn: 2, step: 1, stream: [],
    message: { id: 'later', role: 'assistant', content: [text('后续轮')],
      source: { kind: 'model', provider: 'test', model: 'test' } } }, 'append')
  assert.deepEqual(readTurn(r.entries, 'request'), { answer: '本轮', endSeq: null, reason: null })
  assert.deepEqual(readTurn(r.entries, 'missing'), { answer: '', endSeq: null, reason: null })
})

test('非追加的 assistant surface 替换不成为本轮新的可见消息', () => {
  const r = recording()
  r.message(1, [text('可见正文')])
  r.message(1, [text('内部压缩')], false, { op: 'replace', startSeq: 3, endSeq: 3 })
  assert.equal(readTurn(r.entries, 'request').answer, '可见正文')
})
