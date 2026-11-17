import React from 'react'

export const controlSeat = (name: string) => 'studyTree.card.' + name

// DSH allows each slot to have one declaring owner. Mirror the live native
// registrations into plugin-owned seats, retaining their components, injection,
// locale and stores. Never redeclare a conversation.* slot or mount its editor.
// This adapter is pinned to the DSH version declared in package.json.
export function mirrorNativeControl(ctx, source: string) {
  let stops: (() => void)[] = []
  let previous = null
  const clear = () => {
    for (const stop of stops.reverse()) stop()
    stops = []
  }
  const sync = () => {
    const entries = ctx.slots.entries(source)
    if (entries === previous) return
    previous = entries
    clear()
    for (const entry of entries) {
      const children = Object.fromEntries(
        Object.entries(entry.children || {}).map(([name, spec]) => [controlSeat(name), spec]),
      )
      const Component = entry.component
      const Adapter = (props) => (
        <Component
          {...props}
          renderSlot={(name, owner, options) => props.renderSlot(controlSeat(name), owner, options)}
          renderSlotChain={(name, owner, options) => props.renderSlotChain(controlSeat(name), owner, options)}
        />
      )
      stops.push(ctx.slots.register(
        {
          name: controlSeat(source), ...entry.options,
          children, inject: entry.inject, store: entry.store, locale: entry.locale,
        },
        Adapter,
      ))
      for (const name of Object.keys(entry.children || {}))
        stops.push(mirrorNativeControl(ctx, name))
    }
  }
  const off = ctx.slots.subscribe(source, sync)
  sync()
  return () => {
    off()
    clear()
  }
}
