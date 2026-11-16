import React, { useSyncExternalStore } from 'react'
import { Study } from './study'
import { StudyPage } from './StudyPage'
import '@xyflow/react/dist/style.css'
import './study.css'

declare const STUDY_CSS: string
export const inject = ['slots', 'sessions', 'connection', 'layout']
export function apply(ctx) {
  const study = new Study(ctx)
  // The page owns navigation state. The host owns the sidebar element and its lifetime.
  let seat: HTMLDivElement | null = null
  let wide = true
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const mounts = [false, true].map((expanded) => (el: HTMLDivElement | null) => {
    seat = el
    wide = expanded
    for (const fn of listeners) fn()
  })
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'dsh-study-tree.directory' },
      ({ wide }) => (
        <div key={String(wide)} className="st-sidebar-seat" ref={mounts[Number(wide)]} />
      ),
    ),
  )
  function Panel() {
    const sidebar = useSyncExternalStore(subscribe, () => seat)
    return (
      <>
        <style>{STUDY_CSS}</style>
        <StudyPage
          study={study}
          sidebar={sidebar}
          sidebarWide={wide}
          openSidebar={() => ctx.layout.toggleSidebar()}
        />
      </>
    )
  }
  ctx.effect(() => () => study.dispose())
  ctx.on('connection/reset', () => {
    void study.refresh().catch((e) => {
      study.error = e.message
      study.emit()
    })
  })
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'dsh-study-tree' }, Panel))
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: 'dsh-study-tree',
        order: 5,
        label: () => '学习树',
      },
      ({ size = 20 }) => (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <path d="M5 12h3c4 0 4-6 8-6m-8 6c4 0 4 6 8 6" />
          <circle cx="4" cy="12" r="2" />
          <circle cx="18" cy="6" r="2" />
          <circle cx="18" cy="18" r="2" />
        </svg>
      ),
    ),
  )
}
