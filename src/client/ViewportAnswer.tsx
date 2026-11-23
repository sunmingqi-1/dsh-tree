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
    return watch(card, visible => {
      if (!visible && slot.current) height.current = slot.current.offsetHeight
      setNear(visible)
    })
  }, [defer])
  const mounted = !defer || near
  return <div ref={slot} style={mounted ? undefined : { height: height.current }}>{mounted && children}</div>
}
