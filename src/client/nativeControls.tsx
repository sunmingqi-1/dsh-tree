import React, { useEffect, useRef } from 'react'
import { quoteText } from './nativeDrafts'

export const controlSeat = (name: string) => 'studyTree.card.' + name

// DSH allows each slot to have one declaring owner. Mirror the live native
// registrations into plugin-owned seats, retaining their components, injection,
// locale and stores. Every editor gets a distinct prepared Session binding.
// This adapter is pinned to the DSH version declared in package.json.
export function mirrorNativeControl(ctx, source: string, exclude?: (entry: any) => boolean) {
  return ctx.slots.inject(controlSeat(source), () => mirrorActiveControl(ctx, source, exclude))
}

function mirrorActiveControl(ctx, source: string, exclude?: (entry: any) => boolean) {
  let disposed = false
  const registrations = new Map<any, () => void>()
  let previous = null
  const clear = () => {
    for (const stop of [...registrations.values()].reverse()) stop()
    registrations.clear()
  }
  const sync = () => {
    if (disposed) return
    const entries = ctx.slots.entries(source)
    if (entries === previous) return
    previous = entries
    for (const [entry, stop] of registrations) {
      if (entries.includes(entry) && !exclude?.(entry)) continue
      stop()
      registrations.delete(entry)
    }
    for (const entry of entries) {
      if (exclude?.(entry) || registrations.has(entry)) continue
      const stops: (() => void)[] = []
      const session = source === 'conversation.composer.bar' ? ctx.slots.entries('conversation.session')[0] : null
      const children = Object.fromEntries(
        Object.entries(entry.children || {}).map(([name, spec]) => [controlSeat(name), spec]),
      )
      const Component = entry.component
      const render = (props) => (
        <Component
          {...props}
          renderSlot={(name, owner, options) => props.studySimplified && [
            'conversation.input.permission', 'conversation.input.plan', 'conversation.input.left',
            'conversation.input.right', 'conversation.input.model', 'conversation.input.activity',
            'conversation.composer.dock',
          ].includes(name) ? null : props.renderSlot(controlSeat(name), owner, options)}
          renderSlotChain={(name, owner, options) => props.renderSlotChain(controlSeat(name), owner, options)}
        />
      )
      const Adapter = source !== 'conversation.composer.bar' ? render : function NativeInput(props) {
        const draft = props.useInput(state => state?.draft) || ''
        const seeded = useRef(false)
        useEffect(() => {
          if (!props.bindDraftPersistence || !props.inputActions || !props.actions) return
          const off = props.bindDraftPersistence(props.actions.setDraft)
          props.inputActions.persistDraft()
          return off
        }, [props.bindDraftPersistence, props.inputActions, props.actions])
        useEffect(() => {
          if (!props.studyAnchor || props.disabled || seeded.current || !props.inputActions) return
          seeded.current = true
          if (draft.replace(quoteText(props.studyAnchor.text), '').trim()) return
          props.inputActions.insertText('\n\n请解释引用的内容。', props.inputActions.captureInsertion())
        }, [props.disabled, props.studyAnchor, draft])
        return render(props)
      }
      const register = (options, component) => {
        try { return ctx.slots.register(options, component) }
        catch (error) { throw new Error('原生组件接入 ' + source + '/' + (entry.options.key || entry.options.id || '') + '：' + error.message) }
      }
      stops.push(register(
        {
          name: controlSeat(source), ...entry.options,
          select: entry.select,
          children,
          inject: session ? (sessionId, actions) => ({
            ...entry.inject(sessionId),
            bindDraftPersistence: sessionId === undefined ? undefined : session.inject(sessionId, actions).bindDraftPersistence,
          }) : entry.inject,
          store: session?.store || entry.store,
          locale: entry.locale,
        },
        Adapter,
      ))
      for (const name of Object.keys(entry.children || {}))
        stops.push(mirrorNativeControl(ctx, name))
      registrations.set(entry, () => { for (const stop of stops.reverse()) stop() })
    }
  }
  const off = ctx.slots.subscribe(source, sync)
  sync()
  return () => {
    disposed = true
    off()
    clear()
  }
}
