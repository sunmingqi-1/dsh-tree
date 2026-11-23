import React, { useLayoutEffect, useRef, useState } from 'react'

type Watch = (near: boolean) => void
const observers = new WeakMap<Element, { observer: IntersectionObserver; watches: Map<Element, Watch> }>()

function watch(element: HTMLElement, notify: Watch) {
  const root = element.closest('.react-flow')
  if (!root || typeof IntersectionObserver === 'undefined') {
    notify(true)
    return
  }
  let group = observers.get(root)
  if (!group) {
    const watches = new Map<Element, Watch>()
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) watches.get(entry.target)?.(entry.isIntersecting)
    }, { root, rootMargin: '480px' })
    group = { watches, observer }
    observers.set(root, group)
  }
  group.watches.set(element, notify)
  group.observer.observe(element)
  return () => {
    group.observer.unobserve(element)
    group.watches.delete(element)
    if (!group.watches.size) {
      group.observer.disconnect()
      observers.delete(root)
    }
  }
}

// Keep the card, scrollport and connection handles mounted. Only its costly
// conversation view leaves the DOM, well beyond the visible canvas.
export function ViewportAnswer({ defer, children }: { defer: boolean; children: React.ReactNode }) {
  const slot = useRef<HTMLDivElement>(null)
  const height = useRef(0)
  const [near, setNear] = useState(false)
  useLayoutEffect(() => {
    const card = slot.current?.closest<HTMLElement>('.st-card')
    if (!defer || !card) return
    // Reuse a recently visible editor or native turn when the wheel reverses
    // across the preload boundary. First-time entry is still immediate.
    let eviction: ReturnType<typeof setTimeout> | undefined
    let retained = false
    const unwatch = watch(card, visible => {
      clearTimeout(eviction)
      if (visible) {
        retained = true
        setNear(true)
      } else if (retained) {
        eviction = setTimeout(() => {
          if (slot.current) height.current = slot.current.offsetHeight
          retained = false
          setNear(false)
        }, 1200)
      } else setNear(false)
    })
    return () => { clearTimeout(eviction); unwatch?.() }
  }, [defer])
  const mounted = !defer || near
  return <div ref={slot} style={mounted ? undefined : { height: height.current }}>{mounted && children}</div>
}
