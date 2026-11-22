// rc.5's default sink receives already-expanded editor text. The conversation
// service converts attachments to parts, allocates a handle, and passes its id
// to the 4-argument Session prompt. Acceptance clears the editor.
export function rc5Shell(input, state, notify = () => {}) {
  const accept = () => {
    state.draft = ''
    state.attachmentIds = []
    state.phase = 'plain'
    notify()
  }
  input.deps = { defaultSink: async () => { throw Error('unexpected ordinary message') } }
  input.submit = async function (mode) {
    state.phase = 'sending'
    notify()
    try {
      return await this.deps.defaultSink(state.draft, [...state.attachmentIds], mode, new AbortController().signal, accept)
    } finally {
      state.phase = 'plain'
      notify()
    }
  }
  input.steerQueue = () => {}
  return {
    input: { for: () => input },
    async sendSession(target, text, ids, mode, signal, onAccept) {
      const handle = target.beginSubmission({ mode, text, attachments: ids, onAccept })
      const parts = ids.map(receiptId => ({ type: 'file', receiptId }))
      if (text) parts.push({ type: 'text', text })
      const result = await target.prompt(parts, mode, signal, handle.requestId)
      if (result.ok) onAccept()
      return result
    },
  }
}
