export interface Anchor {
  text: string
  start: number
  prefix: string
  suffix: string
}
export function isUserPrompt(event) {
  const source = event.data?.source
  return event.type === 'user/message' && !!source?.rpcId && (!source.kind || source.kind === 'user')
}
export interface Turn {
  logged?: boolean
  turn?: number
  startSeq?: number
  boundarySeq?: number | null
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

export function readTurn(entries, requestId: string, startSeq?: number) {
  let startTurn = null
  let matched = false
  let endSeq = null
  let reason = null
  let currentStep = 0
  const steps = new Map<number, {
    blocks: Map<number, string>
    attemptId: string | undefined
    settled: boolean
  }>()
  const stepState = (step: number) => {
    let state = steps.get(step)
    if (!state) {
      state = { blocks: new Map(), attemptId: undefined, settled: false }
      steps.set(step, state)
    }
    return state
  }
  let low = 0
  if (startSeq !== undefined) {
    let high = entries.length
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (entries[mid].event.seq < startSeq) low = mid + 1
      else high = mid
    }
  }
  for (let i = low; i < entries.length; i++) {
    const { event } = entries[i]
    const { type, data } = event
    if (type === 'turn/start') {
      // Once the request is located, its boundary never moves to a later turn.
      if (matched) break
      startTurn = data.turn
      if (event.seq === startSeq && data.requestId === requestId) matched = true
      currentStep = 0
    }
    if (type === 'user/message' && data.source?.rpcId === requestId) matched = true
    if (!matched || data.turn !== startTurn) continue
    if (type === 'turn/end') {
      endSeq = event.seq
      reason = data.reason
      break
    }
    if (type === 'step/start') {
      currentStep = data.step
      stepState(currentStep)
      continue
    }
    if (type !== 'assistant/message' && type !== 'assistant/live-chunk'
      && type !== 'assistant/attempt' && type !== 'llm/retry') continue
    const state = stepState(data.step ?? currentStep)
    if (type === 'assistant/message') {
      // Native Chat only treats append messages as Assistant settlements.
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue
      // The successful attempt's live rows may remain until step/end. The
      // durable message replaces those blocks; it is not another paragraph.
      state.blocks = new Map(data.message.content.flatMap((block, index) =>
        block.type === 'text' ? [[index, block.text]] : []))
      state.settled = true
      continue
    }
    if (type === 'assistant/attempt' || type === 'llm/retry') {
      // Failed attempts commit no visible message. Retry resets this Step,
      // while preceding Steps remain readable.
      state.blocks.clear()
      state.attemptId = undefined
      state.settled = false
      continue
    }
    if (state.settled) continue
    if (state.attemptId !== data.attemptId) {
      state.blocks.clear()
      state.attemptId = data.attemptId
    }
    const chunk = data.chunk
    const index = chunk.index ?? 0
    if (chunk.type === 'text-delta') {
      state.blocks.set(index, (state.blocks.get(index) ?? '') + chunk.text)
    } else if (chunk.type === 'block-end' && chunk.block.type === 'text') {
      state.blocks.set(index, chunk.block.text)
    } else if (chunk.type === 'block-start' || chunk.type === 'block-end'
      || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
      state.blocks.delete(index)
    }
  }
  const answer = [...steps.values()]
    .map(state => [...state.blocks].sort(([a], [b]) => a - b).map(([, text]) => text).join(''))
    .filter(Boolean)
    .join('\n\n')
  return { answer, endSeq, reason }
}
