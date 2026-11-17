// Reuse the layer throughout a camera gesture. Re-raster once at the final
// scale instead of repainting all Markdown on every intermediate zoom frame.
export function rasterPolicy(layer: () => HTMLElement | null, initialZoom: number) {
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
    start(event: { type: string } | null) {
      scaling = !event || !['mousedown', 'pointerdown', 'touchstart'].includes(event.type)
      hint('transform')
    },
    change,
    end(view: { zoom: number }) {
      change(view)
      if (scaling) hint('auto')
    },
  }
}
