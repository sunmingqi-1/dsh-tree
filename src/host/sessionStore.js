import { SessionStore, appendPluginRecord, adoptSessionEvent } from '@deepseek-ai/dsh-session'
import { isTreeMarker, PROMPT_RECORD, TREE_MARKER } from './ancestry.js'
import { installTreeSurface } from './branchSurface.js'

// Keep the record writer next to the SessionStore import. Both must resolve to
// the exact same installed session library (appendPluginRecord uses a #private method).
export default class StudyTreeSessionStore extends SessionStore {
  recordStudyTree(session, type, data) {
    if (this.get(session.id) !== session) throw new Error('学习树会话已关闭')
    return appendPluginRecord(session, type, data)
  }

  declareStudyTree(session) {
    if (this.get(session.id) !== session) throw new Error('学习树会话已关闭')
    if (!session.isTree) {
      installTreeSurface(session, this.messageProjections)
      this.recordStudyTree(session, TREE_MARKER, {})
    }
  }

  armStudyTree(session) {
    session.admitStudyTreeRoot ??= () => this.declareStudyTree(session)
  }

  prepare(id, options) {
    if (!options?.seed?.some(isTreeMarker)) {
      const session = super.prepare(id, options)
      if (options?.seed?.some(e => e.type === PROMPT_RECORD && e.ignorable && e.data?.parentSeq === null))
        this.armStudyTree(session)
      return session
    }
    const projections = this.messageProjections
    const replayTypes = new Set(projections.map(projection => projection.type))
    // The stock constructor replays one linear surface while restoring a seed.
    // Defer exactly the path-dependent decisions until its branch fold is ready.
    // The placeholders exist only inside this synchronous construction.
    const deferred = []
    const seed = options.seed.map((event, seq) => {
      if (typeof event.surfaceOp !== 'object' && !replayTypes.has(event.type)) return event
      deferred.push(seq)
      return { type: 'plugin:study-tree/restore', seq: event.seq, time: event.time, ignorable: true, data: event }
    })
    const session = super.prepare(id, { ...options, seed })
    for (const seq of deferred) session.log[seq] = adoptSessionEvent(session.log[seq].data)
    installTreeSurface(session, projections)
    return session
  }
}
