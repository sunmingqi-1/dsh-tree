import React from 'react'
import { Study } from './study'
import { StudyPage } from './StudyPage'
import '@xyflow/react/dist/style.css'
import './study.css'

declare const STUDY_CSS: string
export const inject = ['slots', 'sessions', 'connection']
export function apply(ctx) {
  const study = new Study(ctx)
  ctx.effect(() => () => study.dispose())
  ctx.on('connection/reset', () => {
    void study.refresh().catch((e) => {
      study.error = e.message
      study.emit()
    })
  })
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: 'dsh-study-tree' }, () => (
      <>
        <style>{STUDY_CSS}</style>
        <StudyPage study={study} />
      </>
    )),
  )
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
