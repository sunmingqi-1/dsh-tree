// Reuse the layer throughout a camera gesture. Re-raster once at the final
// scale instead of repainting all Markdown on every intermediate zoom frame.
export function rasterPolicy(layer: () => HTMLElement | null, initialZoom: number, settled: (zoom: number) => void = () => {}) {
  let zoom = initialZoom, scaling = false
  const hint = (value: string) => {
    const element = layer()
    if (element && element.style.willChange !== value) element.style.willChange = value
  }
  const change = (view: { zoom: number }) => {
    if (Math.abs(view.zoom - zoom) > 0.000001) {
      scaling = true
      hint('transform')
    }
    zoom = view.zoom
  }
  return {
    start(_event: { type: string } | null) {
      // Programmatic camera moves also come from minimap panning. Only actual
      // scale changes need a final text refresh, regardless of event source.
      scaling = false
      hint('transform')
    },
    change,
    end(view: { zoom: number }) {
      change(view)
      if (scaling) {
        hint('auto')
        settled(zoom)
      }
    },
  }
}

// Lay out small floating headers at their displayed pixel size, then cancel
// the viewport's transform scale locally. Keep this out of intermediate frames.
export function headerRasterScale(element: HTMLElement | null, zoom: number) {
  if (!element || !Number.isFinite(zoom) || zoom <= 0) return
  const value = String(zoom)
  if (element.style.getPropertyValue('--st-header-scale') !== value)
    element.style.setProperty('--st-header-scale', value)
}
