import { useCallback, useEffect, useRef, useState } from 'react'
import { applyNodeChanges } from '@xyflow/react'
import { adaptLayout, type Rect, type Rects } from './adaptive'
import type { Positions } from './layout'
import { DEFAULT_CARD_SIZE } from './cardSize.ts'

export function nodeRect(node): Rect {
  return {
    ...node.position,
    width: node.width ?? node.measured?.width ?? node.style?.width ?? DEFAULT_CARD_SIZE.width,
    height: node.height ?? node.measured?.height ?? node.style?.height ?? DEFAULT_CARD_SIZE.height,
  }
}

export function useAdaptiveNodes(nodes, onCommit, interacting) {
  const [display, setDisplay] = useState(nodes)
  const current = useRef(nodes)
  const gesture = useRef<{ id: string; kind: 'drag' | 'resize'; base: Rects } | null>(null)
  const commit = useRef(onCommit)
  commit.current = onCommit
  const publish = useCallback(next => {
    current.current = next
    setDisplay(next)
  }, [])
  const begin = useCallback((id, kind: 'drag' | 'resize') => {
    if (gesture.current) return
    gesture.current = {
      id, kind,
      base: Object.fromEntries(current.current.map(node => [node.id, nodeRect(node)])),
    }
    interacting.current = true
  }, [interacting])
  const solve = useCallback(next => {
    const g = gesture.current
    if (!g) return next
    const active = next.find(node => node.id === g.id)
    if (!active) return next
    const sizes = Object.fromEntries(next.map(node => {
      const { width, height } = nodeRect(node)
      return [node.id, { width, height }]
    }))
    const positions = adaptLayout(g.base, g.id, nodeRect(active), sizes)
    return next.map(node => {
      const point = positions[node.id]
      return !point || (point.x === node.position.x && point.y === node.position.y)
        ? node : { ...node, position: point }
    })
  }, [])
  const finish = useCallback((id, finalRect?: Rect) => {
    const g = gesture.current
    if (!g || g.id !== id) return
    let next = current.current
    if (finalRect) next = next.map(node => node.id === id ? {
      ...node,
      position: { x: finalRect.x, y: finalRect.y },
      width: finalRect.width,
      height: finalRect.height,
      measured: { width: finalRect.width, height: finalRect.height },
      resizing: false,
    } : node)
    next = solve(next)
    publish(next)
    const positions: Positions = Object.fromEntries(next.map(node => [node.id, node.position]))
    const size = g.kind === 'resize' ? nodeRect(next.find(node => node.id === id)) : null
    gesture.current = null
    interacting.current = false
    commit.current(positions, size ? { id, width: size.width, height: size.height } : null)
  }, [solve, publish, interacting])
  const onNodesChange = useCallback(changes => {
    const resize = changes.find(change => change.type === 'dimensions' && change.resizing)
    const move = changes.find(change => {
      if (change.type !== 'position' || !change.position) return false
      const previous = current.current.find(node => node.id === change.id)?.position
      return change.dragging === true || !previous || previous.x !== change.position.x || previous.y !== change.position.y
    })
    let atomic = false
    if (!gesture.current && (resize || move)) {
      begin((resize || move).id, resize ? 'resize' : 'drag')
      // Keyboard movement has no pointer start/stop events.
      atomic = !resize && move.dragging !== true
    }
    publish(solve(applyNodeChanges(changes, current.current)))
    if (atomic) finish(move.id)
  }, [begin, finish, publish, solve])

  useEffect(() => {
    const previous = new Map(current.current.map(node => [node.id, node]))
    const g = gesture.current
    const next = nodes.map(node => {
      const retained: any = previous.get(node.id)
      const live = g && retained
      if (g && !g.base[node.id]) g.base[node.id] = nodeRect(node)
      return {
        ...retained, ...node,
        position: live ? retained.position : node.position,
        width: live ? retained.width : node.style?.width,
        height: live ? retained.height : node.style?.height,
      }
    })
    publish(g ? solve(next) : next)
  }, [nodes, publish, solve])
  useEffect(() => () => { interacting.current = false }, [interacting])
  return { display, onNodesChange, begin, finish }
}
