// The rc.5 composer owns its editor, reference expansion, attachment receipts
// and settlement. Adapt its per-input send boundary for one mounted tree seat.
// No shared Session, RPC transport or ordinary composer is modified.
type Branch = {
  parentSeq: number | null
  metadata: { studyTree: { id: string; anchor?: unknown; versionOf?: string; branchKind?: 'card' | 'quote' } }
  onRequest: (requestId: string) => void
}

export async function sendBranchPrompt(study, sessionId, session, handle, branch: Branch, content, signal?) {
  const { requestId } = handle
  try {
    signal?.throwIfAborted()
    await study.call('preparePrompt', { request: {
      sessionId, requestId, parentSeq: branch.parentSeq, metadata: branch.metadata,
    } })
    signal?.throwIfAborted()
    branch.onRequest(requestId)
    const result = await session.prompt(content, 'queue', signal, requestId)
    if (!result.ok) throw new Error(result.error.message)
    return result
  } catch (error) {
    study.forgetSubmission(branch.metadata.studyTree.id)
    handle.abandon()
    throw error
  }
}

const commandNotice = '此命令作用于整个会话。请在普通对话中使用。'
const isEditing = input => ['plain', 'claimed'].includes(input.state.getSnapshot().phase)
type Resolver = () => Branch
const activeInputs = new WeakMap<object, (resolve: Resolver) => () => void>()

export function bindBranchInput(study, binding, sessionId, resolve: Resolver) {
  const conversation = study.ctx.conversation
  const input = conversation.input.for(binding.ctx)
  const active = activeInputs.get(input)
  if (active) return active(resolve)
  const { deps, submit, steerQueue } = input
  if (typeof deps?.defaultSink !== 'function' || typeof conversation.sendSession !== 'function')
    throw new Error('当前 DSH 输入框不支持学习树发送（需要 0.2.2-rc.5）')
  const defaultSink = deps.defaultSink
  const owners = new Set<Resolver>()
  let branch: Branch | undefined
  input.submit = (_mode, source, allowEmpty) => {
    if (!isEditing(input)) return
    const current = [...owners].at(-1)
    if (!current) return submit.call(input, _mode, source, allowEmpty)
    const state = input.state.getSnapshot()
    if (state.claim || /^\/compact(?:\s|$)/iu.test(state.draft.trimStart())) {
      input.notify('info', commandNotice)
      return
    }
    branch = current()
    return submit.call(input, 'queue', source, allowEmpty)
  }
  input.steerQueue = () => input.notify('info', '学习树提问按所选节点排队发送。')
  deps.defaultSink = async (text, attachmentIds, _mode, signal, accept) => {
    const selected = branch
    // A plain composer may already have been serializing a reference when
    // the user armed the new-study action for this Session.
    if (!selected) return defaultSink.call(deps, text, attachmentIds, _mode, signal, accept)
    branch = undefined
    const session = binding.session
    let handle
    // rc.5 sendSession only needs these three operations. Its own receipt
    // and inbox acceptance race still owns draft clearing and attachment GC.
    const scoped = {
      sessionId,
      beginSubmission: options => (handle = session.beginSubmission(options)),
      prompt: (content, _delivery, abort, requestId) => {
        if (!handle || requestId !== handle.requestId) throw new Error('学习树发送标识不匹配')
        return sendBranchPrompt(study, sessionId, session, handle, selected, content, abort)
      },
    }
    return conversation.sendSession(scoped, text, attachmentIds, 'queue', signal, accept)
  }

  // Host commands bypass the prompt pipe. Keep the native slash source for
  // client actions and resolve host commands against rc.5's own catalog.
  const triggers = deps.inputTriggers?.()
  const directory = binding.ctx.get?.('commandUi')?.directory
  const adjudicate = triggers?.adjudicate, pick = triggers?.pick
  if (triggers && directory) {
    triggers.adjudicate = async (line, signal, envelope) => {
      if (line.startsWith('/')) {
        await directory.ensureReady(sessionId, signal)
        if (directory.resolve(sessionId, line.slice(1).split(/\s/u, 1)[0])) throw new Error(commandNotice)
      }
      return adjudicate.call(triggers, line, signal, envelope)
    }
    triggers.pick = (source, index, action) => {
      const group = triggers.menu.getSnapshot().groups.find(item => item.source === source)
      const name = group?.status === 'ready' && group.items[index]?.name
      if (source === 'command' && name && directory.resolve(sessionId, name)) {
        input.notify('info', commandNotice)
        return
      }
      return pick.call(triggers, source, index, action)
    }
  }

  let unsubscribe: (() => void) | undefined
  const restore = () => {
    // An async reference serializer can still enter defaultSink after the
    // user navigates away. Keep this exact binding until that attempt settles.
    if (owners.size || !isEditing(input)) return
    unsubscribe?.()
    activeInputs.delete(input)
    input.submit = submit
    input.steerQueue = steerQueue
    deps.defaultSink = defaultSink
    if (triggers && directory) {
      triggers.adjudicate = adjudicate
      triggers.pick = pick
    }
  }
  const attach = (owner: Resolver) => {
    owners.add(owner)
    return () => {
      if (!owners.delete(owner) || owners.size) return
      if (!isEditing(input)) unsubscribe ??= input.state.subscribe(restore)
      else restore()
    }
  }
  activeInputs.set(input, attach)
  return attach(resolve)
}
