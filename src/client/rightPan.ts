import type { Viewport } from '@xyflow/react'

type Camera = {
  getViewport: () => Viewport | undefined
  move: (view: Viewport) => void
  start: (event: PointerEvent) => void
  end: (view: Viewport) => void
}

export function bindRightPan(surface: HTMLElement, camera: Camera) {
  const win = surface.ownerDocument.defaultView!
  const rightButton = 2
  const dragThreshold = 4
  let gesture: { id: number; x: number; y: number; startView?: Viewport; view?: Viewport } | undefined
  let frame: number | undefined
  let suppressMenuUntil = 0

  const draw = () => {
    frame = undefined
    if (gesture?.view) camera.move(gesture.view)
  }
  const finish = () => {
    if (!gesture) return
    const { id, view } = gesture
    if (frame !== undefined) {
      win.cancelAnimationFrame(frame)
      frame = undefined
    }
    gesture = undefined
    if (view) {
      camera.move(view)
      suppressMenuUntil = win.performance.now() + 500
      surface.removeAttribute('data-right-panning')
      if (surface.hasPointerCapture(id)) surface.releasePointerCapture(id)
      camera.end(view)
    }
  }
  const down = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || event.button !== rightButton) return
    suppressMenuUntil = 0
    if (!(event.target instanceof Node) || !surface.contains(event.target)) return
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY }
  }
  const move = (event: PointerEvent) => {
    if (gesture?.id !== event.pointerId) return
    if (!(event.buttons & rightButton)) {
      finish()
      return
    }
    const dx = event.clientX - gesture.x
    const dy = event.clientY - gesture.y
    if (!gesture.startView) {
      if (dx * dx + dy * dy < dragThreshold * dragThreshold) return
      const view = camera.getViewport()
      if (!view) return
      gesture.startView = view
      surface.setPointerCapture(event.pointerId)
      surface.setAttribute('data-right-panning', '')
      camera.start(event)
    }
    event.preventDefault()
    event.stopPropagation()
    const { x, y, zoom } = gesture.startView
    gesture.view = { x: x + dx, y: y + dy, zoom }
    frame ??= win.requestAnimationFrame(draw)
  }
  const up = (event: PointerEvent) => {
    if (gesture?.id !== event.pointerId || event.button !== rightButton) return
    if (gesture.startView) {
      const { x, y, zoom } = gesture.startView
      gesture.view = { x: x + event.clientX - gesture.x, y: y + event.clientY - gesture.y, zoom }
    }
    finish()
  }
  const cancel = (event: PointerEvent) => {
    if (gesture?.id === event.pointerId) finish()
  }
  const menu = (event: MouseEvent) => {
    if (event.button !== rightButton || (!gesture?.startView && win.performance.now() >= suppressMenuUntil)) return
    event.preventDefault()
    event.stopPropagation()
  }

  win.addEventListener('pointerdown', down, true)
  win.addEventListener('pointermove', move, true)
  win.addEventListener('pointerup', up, true)
  win.addEventListener('pointercancel', cancel, true)
  win.addEventListener('contextmenu', menu, true)
  win.addEventListener('blur', finish)
  return () => {
    win.removeEventListener('pointerdown', down, true)
    win.removeEventListener('pointermove', move, true)
    win.removeEventListener('pointerup', up, true)
    win.removeEventListener('pointercancel', cancel, true)
    win.removeEventListener('contextmenu', menu, true)
    win.removeEventListener('blur', finish)
    if (frame !== undefined) win.cancelAnimationFrame(frame)
    if (gesture && surface.hasPointerCapture(gesture.id)) surface.releasePointerCapture(gesture.id)
    surface.removeAttribute('data-right-panning')
  }
}
