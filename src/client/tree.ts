export interface Anchor {
  text: string
  start: number
  prefix: string
  suffix: string
}
export interface Turn {
  title?: string
  versionOf?: string
  id: string
  treeId: string
  parentId: string | null
  question: string
  anchor: Anchor | null
  created: number
  sessionId: string | null
  requestId: string | null
  endSeq: number | null
  status: 'preparing' | 'sending' | 'complete' | 'failed' | 'stopped'
  error: string | null
  revision: number
}
export function pathTo(nodes: Turn[], id: string | null): Turn[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const seen = new Set<string>()
  const path = []
  while (id && !seen.has(id)) {
    const n = byId.get(id)
    if (!n) break
    seen.add(id)
    path.unshift(n)
    id = n.parentId
  }
  return path
}

export function readTurn(entries, requestId: string) {
  let startTurn = null
  let matched = false
  let answer = ''
  let endSeq = null
  let reason = null
  for (const { event } of entries) {
    const { type, data } = event
    if (type === 'turn/start') {
      startTurn = data.turn
      matched = false
    }
    if (type === 'user/message' && data.source?.rpcId === requestId) matched = true
    if (!matched) continue
    if (type === 'assistant/message' && data.turn === startTurn) {
      const text = data.message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
      if (text) answer += (answer ? '\n\n' : '') + text
    }
    if (
      type === 'assistant/live-chunk' &&
      data.turn === startTurn &&
      data.chunk.type === 'text-delta'
    )
      answer += data.chunk.text
    if (type === 'turn/end' && data.turn === startTurn) {
      endSeq = event.seq
      reason = data.reason
      break
    }
  }
  return { answer, endSeq, reason }
}
