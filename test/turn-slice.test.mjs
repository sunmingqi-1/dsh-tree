import test from 'node:test'
import assert from 'node:assert/strict'
import { turnKeys, turnNumber, interactionOwner, processVisibility } from '../src/client/turnSlice.ts'

function fixture(rows, openTurn = 2) {
  const map = new Map(rows.map(([key, kind, turn, data]) => [key, { key, kind, data, location: { kind: 'step', turn: { turn } } }]))
  const snapshot = { order: [...map.keys()], nodes: { get: key => map.get(key), values: () => map.values() },
    locations: { getTurn: turn => [...map.values()].filter(n => n.location.turn.turn === turn).map(n => n.key) } }
  return { snapshot, map, bindings: new Map([['session', { target: () => ({ getSnapshot: () => snapshot }), openTurn: { getSnapshot: () => openTurn } }]]) }
}

test('卡片只包含请求所属轮的原生过程，不混入祖先或后续提问', () => {
  const { snapshot } = fixture([
    ['u1', 'user', 1, { source: { rpcId: 'a' } }], ['a1', 'assistant-step', 1, {}],
    ['u2', 'user', 2, { source: { rpcId: 'b' } }], ['c2', 'context', 2, {}],
    ['a2', 'assistant-step', 2, {}], ['t2', 'tool-call', 2, {}], ['e2', 'turn-tail', 2, {}],
    ['u3', 'user', 3, { source: { rpcId: 'c' } }], ['a3', 'assistant-step', 3, {}],
  ])
  assert.equal(turnNumber(snapshot, 'b'), 2)
  assert.equal(turnKeys(snapshot, 'b'), 'a2\u001ft2\u001fe2')
  assert.equal(turnKeys(snapshot, 'unknown'), '')
})

test('正文增量不改变key签名，替换窗口后旧request索引失效', () => {
  const { snapshot, map } = fixture([['u', 'user', 2, { source: { rpcId: 'b' } }], ['a', 'assistant-step', 2, { text: '首段' }]])
  const before = turnKeys(snapshot, 'b')
  map.get('a').data = { text: '首段和第二段' }
  assert.equal(turnKeys(snapshot, 'b'), before)
  map.delete('u')
  assert.equal(turnNumber(snapshot, 'b'), undefined)
})

test('提问callId关联到原轮，含子工具调用，不能被同会话旧卡认领', () => {
  const { bindings } = fixture([
    ['u1', 'user', 1, { source: { rpcId: 'a' } }], ['u2', 'user', 2, { source: { rpcId: 'b' } }],
    ['tool', 'tool-call', 2, { root: { callId: 'outer', subCalls: [{ callId: 'question' }] } }],
  ])
  const nodes = [{ id: 'old', sessionId: 'session', requestId: 'a' }, { id: 'current', sessionId: 'session', requestId: 'b' }]
  assert.equal(interactionOwner({ sessionId: 'session', callId: 'question' }, nodes, bindings, new Map()), 'current')
  assert.equal(interactionOwner({ sessionId: 'session' }, nodes, bindings, new Map()), 'current')
  assert.equal(interactionOwner({ sessionId: 'other', callId: 'question' }, nodes, bindings, new Map()), undefined)
  assert.equal(interactionOwner({ sessionId: 'session', callId: 'missing' }, nodes, bindings, new Map()), undefined)
})

test('折叠生成过程只隐藏最终答案之前的思考和工具，保留正文和交互回复', () => {
  const process = { turnClosed: true, hasExternalProcess: true, spec: { processStartSeq: 10, answerAnchorSeq: 40, answerStep: 3, inlineReasoning: true } }
  const view = (kind, seq, groupTree) => processVisibility({ kind, anchorSeq: seq, groupTree }, process, false)
  assert.equal(view('assistant-step', 15).hidden, true)
  assert.equal(view('tool-call', 25).hidden, true)
  assert.equal(view('assistant-step', 40).hidden, false)
  assert.equal(view('turn-process', 10, 'turn').hidden, false)
  assert.equal(view('turn-tail', 55, 'turn').hidden, false)
  assert.equal(view('question-reply', 30, 'input').hidden, false)
  assert.equal(view('assistant-step', 40).open, false)
  assert.equal(view('assistant-step', 40).foldable, true)
  assert.equal(processVisibility({ kind: 'tool-call', anchorSeq: 25 }, process, true).hidden, false)
})

test('生成中或没有最终答案时保持过程可见，避免收起后空白', () => {
  const node = { kind: 'tool-call', anchorSeq: 25 }
  const process = { turnClosed: false, hasExternalProcess: true, spec: { processStartSeq: 10, answerAnchorSeq: 40, answerStep: 3 } }
  assert.equal(processVisibility(node, process, false).open, true)
  assert.equal(processVisibility(node, { ...process, turnClosed: true, spec: { ...process.spec, answerAnchorSeq: null } }, false).hidden, false)
})

test('有最终答案的轮次成功结束后默认收起过程，手动选择优先', () => {
  const process = { turnClosed: true, hasExternalProcess: true, spec: { processStartSeq: 10, answerAnchorSeq: 40, answerStep: 3 } }
  const tool = { kind: 'tool-call', anchorSeq: 25, location: { turn: { end: { data: { reason: { kind: 'completed' } } } } } }
  assert.equal(processVisibility(tool, { ...process, turnClosed: false }, null).open, true)
  assert.equal(processVisibility(tool, process, null).hidden, true)
  assert.equal(processVisibility(tool, process, true).hidden, false)
  const failed = { ...tool, location: { turn: { end: { data: { reason: { kind: 'failed' } } } } } }
  assert.equal(processVisibility(failed, process, null).hidden, false)
})
