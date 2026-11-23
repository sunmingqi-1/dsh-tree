import React from 'react'
import { MiniMap, useReactFlow } from '@xyflow/react'
import { nodeMarks } from '../nodeMarks.js'

const nodeColor = node => nodeMarks[node.data.turn?.mark]?.color || (node.selected ? 'var(--st-path)' : 'var(--st-edge)')

export const CanvasMiniMap = React.memo(function CanvasMiniMap() {
  const flow = useReactFlow()
  return <MiniMap
    className="st-minimap"
    position="bottom-right"
    style={{ width: 176, height: 120 }}
    ariaLabel="学习树小地图"
    bgColor="var(--st-pane)"
    maskColor="color-mix(in srgb, var(--st-bg) 72%, transparent)"
    maskStrokeColor="var(--st-path)"
    maskStrokeWidth={1}
    nodeColor={nodeColor}
    nodeBorderRadius={8}
    pannable
    onClick={(_, point) => flow.setCenter(point.x, point.y, { zoom: flow.getZoom(), duration: 120 })}
  />
})
