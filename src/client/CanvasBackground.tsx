import React, { memo, useLayoutEffect, useRef } from 'react'
import { useStoreApi } from '@xyflow/react'

// React Flow still owns gestures and coordinates. Move a bounded texture instead
// of rendering a new SVG pattern through React for every pointer movement.
export const CanvasBackground = memo(function CanvasBackground() {
  const store = useStoreApi()
  const texture = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = texture.current
    if (!element) return
    let previous: [number, number, number] | undefined
    const update = () => {
      const [x, y, zoom] = store.getState().transform
      if (previous && previous[0] === x && previous[1] === y && previous[2] === zoom) return
      const gap = 24 * zoom
      const wrap = (value: number) => ((value % gap) + gap) % gap
      if (!previous || previous[2] !== zoom) {
        element.style.setProperty('--st-grid-gap', `${gap}px`)
        element.style.setProperty('--st-grid-radius', `${zoom / 2}px`)
      }
      element.style.transform = `translate3d(${wrap(x)}px, ${wrap(y)}px, 0)`
      previous = [x, y, zoom]
    }
    update()
    return store.subscribe(update)
  }, [store])
  return (
    <div className="st-grid" aria-hidden="true">
      <div className="st-grid-texture" ref={texture} />
    </div>
  )
})
