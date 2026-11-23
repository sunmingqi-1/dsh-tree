// Only the turn admitted for this request belongs in its learning card.
// Returning a signature keeps token changes confined to keyed native rows.
const requests = new WeakMap<object, Map<string, { key: string; turn: number }>>()
export function turnNumber(snapshot, requestId: string): number | undefined {
  let cache = requests.get(snapshot.nodes)
  if (!cache) {
    cache = new Map()
    requests.set(snapshot.nodes, cache)
  }
  const known = cache.get(requestId)
  const current = known && snapshot.nodes.get(known.key)
  if (
    current?.data?.source?.rpcId === requestId &&
    ['turn', 'step'].includes(current.location.kind)
  )
    return current.location.turn.turn
  for (const key of snapshot.order) {
    const node = snapshot.nodes.get(key)
    if (
      node?.data?.source?.rpcId === requestId &&
      (node.location.kind === 'turn' || node.location.kind === 'step')
    ) {
      const turn = node.location.turn.turn
      cache.set(requestId, { key, turn })
      return turn
    }
  }
}

export function turnKeys(snapshot, requestId: string, reader = false, visibleTurns?: number[]): string {
  const turn = visibleTurns ? undefined : turnNumber(snapshot, requestId)
  const numbers = visibleTurns ?? (turn === undefined ? [] : [turn])
  return numbers.flatMap(number => snapshot.locations.getTurn(number))
    .filter((key) => {
      const node = snapshot.nodes.get(key)
      return (
        node &&
        (reader || !['user', 'steering', 'context', 'system-prompt', 'inherited-history'].includes(node.kind))
      )
    })
    .join('\u001f')
}

export function interactionOwner(pending, nodes, bindings, turns) {
  const candidates = nodes.filter((n) => n.sessionId === pending.sessionId)
  const snapshot = bindings.get(pending.sessionId)?.target('chat').getSnapshot()
  if (!snapshot) return undefined
  let turn: number | undefined
  if (pending.callId) {
    const hasCall = (root) =>
      root && (root.callId === pending.callId || (root.subCalls || []).some(hasCall))
    for (const node of snapshot.nodes.values()) {
      if (node.kind === 'tool-call' && hasCall(node.data?.root)) {
        if (node.location.kind === 'step' || node.location.kind === 'turn')
          turn = node.location.turn.turn
      }
    }
  } else {
    turn = bindings.get(pending.sessionId)?.openTurn.getSnapshot()
  }
  if (turn === undefined) return undefined
  return candidates.find((n) => n.continuations?.some(part => part.turn === turn) || (turns.get(n.id) ?? turnNumber(snapshot, n.requestId)) === turn)?.id
}

export function processVisibility(node, presentation, expanded: boolean | null) {
  const spec = presentation?.spec
  const hasContent =
    !!spec &&
    (presentation.hasExternalProcess || presentation.hasNonReplyProcess || spec.inlineReasoning)
  const foldable = !!(
    hasContent &&
    presentation.turnClosed &&
    spec.answerAnchorSeq !== null &&
    spec.answerStep !== null
  )
  const completed = node?.location?.turn?.end?.data?.reason?.kind === 'completed'
  const open = !foldable || (expanded ?? !completed)
  const outside = ['exchange', 'input', 'turn'].includes(node?.groupTree)
  const hidden = !!(
    node &&
    foldable &&
    !open &&
    !outside &&
    !['turn-process', 'turn-tail'].includes(node.kind) &&
    node.anchorSeq >= spec.processStartSeq &&
    node.anchorSeq < spec.answerAnchorSeq
  )
  return { foldable, open, hidden, hasContent }
}
