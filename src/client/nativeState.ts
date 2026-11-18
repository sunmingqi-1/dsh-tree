import { interactionOwner } from './turnSlice'

export class NativeTurns {
  seats = new Map<HTMLElement, any>()
  bindings = new Map<string, any>()
  holds = new Map<string, number>()
  reveal = new Map<string, () => void>()
  listeners = new Set<() => void>()
  version = 0
  reconnect = 0
  subscribe = (listener) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getSnapshot = () => this.version
  emit() {
    this.version++
    for (const listener of this.listeners) listener()
  }
}

export class NativeInteractions {
  seats = new Map<string, HTMLElement>()
  owners = new Map<any, string>()
  leases = new Map<any, HTMLElement>()
  constructor(readonly study) {}
  owner(pending) {
    if (!pending) return undefined
    if (!this.owners.has(pending.key)) {
      const id = interactionOwner(
        pending,
        this.study.nodes,
        this.study.turns.bindings,
        this.study.turnNumbers,
      )
      if (id) this.owners.set(pending.key, id)
    }
    return this.owners.get(pending.key)
  }
}

export function pendingSource(service) {
  const source = service.pendingInteractions || service.sessionStatus
  return {
    subscribe: source.subscribe,
    get: (sessionId) => {
      const value = source.getSnapshot().get(sessionId)
      return service.pendingInteractions ? value : value?.pendingInteraction
    },
  }
}
