import test from 'node:test'
import assert from 'node:assert/strict'
import { readTurn, pathTo } from '../src/client/tree.ts'

test('兄弟分支使用相同轮号时，阅读区仍只显示选中的祖先', () => {
  const records = [
    { id: 'root', parentId: null },
    { id: 'a', parentId: 'root' },
    { id: 'b', parentId: 'root' },
    { id: 'aa', parentId: 'a' },
  ]
  assert.deepEqual(
    pathTo(records, 'b').map((n) => n.id),
    ['root', 'b'],
  )
  assert.deepEqual(
    pathTo(records, 'aa').map((n) => n.id),
    ['root', 'a', 'aa'],
  )
})

test('会话继承历史和之后的输入都不进入本节点，使用持久化的结束序号分叉', () => {
  const entries = []
  const add = (type, data) => entries.push({ event: { type, seq: entries.length, data } })
  function turn(turn, request, text) {
    add('turn/start', { turn })
    add('user/message', { source: { rpcId: request } })
    add('assistant/message', { turn, message: { content: [{ type: 'text', text }] } })
    add('turn/end', { turn, reason: { kind: 'completed' } })
  }
  turn(1, 'parent', '根回答')
  turn(2, 'branch', '子回答')
  turn(3, 'outside', '来自另一个入口的问答')
  assert.deepEqual(readTurn(entries, 'branch'), {
    answer: '子回答',
    endSeq: 7,
    reason: { kind: 'completed' },
  })
})
