import React, { useMemo } from 'react'
import { useStudy } from './WorkspaceTree'
import { controlSeat, mirrorNativeControl } from './nativeControls'
import { workspaceProjection } from './workspaceProjection'

// Reuse the installed native browser (menus, search, paging and styling), but
// remove plugin-internal rows before it groups and paginates its own list.
export function installNativeWorkspace(ctx, study) {
  const source = 'sidebar.workspaces'
  return ctx.slots.inject(source, () => {
    const BrowserSeat = ({ renderSlot, ...owner }) => renderSlot(controlSeat(source), owner)
    const off = ctx.slots.register({ name: source, id: 'dsh-study-tree.workspace-browser', priority: -100,
      children: { [controlSeat(source)]: { kind: 'single', scope: 'root' } },
    }, BrowserSeat)
    const stop = mirrorNativeControl(ctx, source, entry => entry.component === BrowserSeat,
      NativeBrowser => function StudyWorkspace(props) {
        useStudy(study)
        const draftRows = [
          ...Object.entries(study.readerDrafts),
          ...Object.entries(study.composers.sessions).map(([key, id]) => [JSON.parse(key)[0], id]),
        ] as [string, string][]
        const project = useMemo(() => {
          const roots = new Map(study.nodes.filter(n => !n.parentId).map(n => [n.id, n.sessionId]))
          const nodes = new Map(study.nodes.map(n => [n.id, n]))
          const owners = Object.fromEntries(draftRows.map(([parent, id]) => [id, roots.get(nodes.get(parent)?.treeId)]))
          return workspaceProjection(study.nodes, draftRows.map(([, id]) => id), owners)
        }, [study.nodes, JSON.stringify(draftRows)])
        const useSessions = useMemo(() => selector => props.useSessions(state => selector(project(state))), [props.useSessions, project])
        return <NativeBrowser {...props} useSessions={useSessions} />
      })
    return () => { stop(); off() }
  })
}
