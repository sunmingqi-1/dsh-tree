import React from 'react'
import { GitBranch } from 'lucide-react'
import { Study } from './study'
import { WorkspaceTree, NewStudyButton, useStudy } from './WorkspaceTree'
import { NativeFrame } from './NativeFrame'
import { NativeComposerBridge } from './NativeComposer'
import { controlSeat, mirrorNativeControl } from './nativeControls'
import { NativeTurnBridge, installNativeTurns, nativeTurnSpec, turnSeat } from './NativeTurn'
import { installNativeInteractions } from './NativeInteraction'
import '@xyflow/react/dist/style.css'
import './study.css'

declare const STUDY_CSS: string
export const inject = [
  'slots',
  'sessions',
  'connection',
  'layout',
  'contextMenus',
  'workspaces',
  'uiWorkspace',
  'uiSession',
  'conversation',
  'uiConversation',
]
export function apply(ctx) {
  const study = new Study(ctx)
  const representatives = new Map()
  ctx.effect(() => () => study.dispose())
  const refresh = () =>
    void study.refresh().catch((error) => {
      study.error = error.message
      study.emit()
    })
  refresh()
  ctx.on('connection/reset', () => { study.turns.reconnect++; study.turns.emit(); refresh() })
  ctx.effect(() => ctx.workspaces.list.subscribe(() => study.emit()))
  ctx.effect(() => {
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  })
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'dsh-study-tree.styles' }, (props) => (
      <>
        <style>{STUDY_CSS}</style>
        <NativeFrame {...props} study={study} />
      </>
    )),
  )
  ctx.slots.inject('sidebar.session.row.trailing', () =>
    ctx.slots.register(
      { name: 'sidebar.session.row.trailing', id: 'dsh-study-tree.directory' },
      (props) => <WorkspaceTree study={study} {...props} representatives={representatives} />,
    ),
  )
  ctx.effect(() =>
    ctx.contextMenus.register({
      id: 'dsh-study-tree.workspace',
      target: 'workspace',
      order: 250,
      resolve: ({ workspaceId }) => [
        {
          id: 'new-study',
          label: '新建学习主题',
          run: () => {
            study.workspaceId = workspaceId
            study.open(null)
          },
        },
      ],
    }),
  )
  ctx.effect(() =>
    ctx.contextMenus.register({
      id: 'dsh-study-tree.session',
      target: 'session',
      order: 250,
      resolve: ({ sessionId }) => {
        const node = study.nodes.find((item) => item.sessionId === sessionId)
        return [
          {
            id: 'open-study',
            label: node ? '打开学习画布' : '新建学习主题',
            run: () => {
              if (!node)
                study.workspaceId = ctx.workspaces.list
                  .getSnapshot()
                  .items.find((workspace) => workspace.sessionIds.includes(sessionId))?.workspaceId
              study.open(node?.id || null)
            },
          },
        ]
      },
    }),
  )
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      { name: 'conversation.session.header.actions', id: 'dsh-study-tree.new', children: {
        [controlSeat('conversation.composer.bar')]: { kind: 'single', scope: 'session' },
        [turnSeat]: nativeTurnSpec(ctx),
      } },
      (props) => <><NewStudyButton study={study} sessionId={props.sessionId} /><NativeComposerBridge study={study} {...props} /><NativeTurnBridge study={study} {...props} /></>,
    ),
  )
  ctx.effect(() => {
    const stops = [mirrorNativeControl(ctx, 'conversation.composer.bar'), installNativeTurns(ctx), installNativeInteractions(ctx, study)]
    return () => stops.forEach(stop => stop())
  })
  ctx.slots.inject('conversation.hero.options', () =>
    ctx.slots.register(
      { name: 'conversation.hero.options', id: 'dsh-study-tree.new' },
      ({ sessionId }) => {
        useStudy(study)
        if (study.creating) return null
        return (
          <button
            className="st-native-start"
            type="button"
            aria-label="以学习画布开始"
            title="以学习画布开始"
            onClick={() => {
              if (sessionId) study.armRoot(sessionId)
              else study.startNew()
            }}
          >
            <GitBranch size={16} aria-hidden="true" />
            <span>学习画布</span>
          </button>
        )
      },
    ),
  )
}
