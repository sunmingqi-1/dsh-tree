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

// Downsampling a normal-size title needs no extra layout. When magnified, only
// titles on screen need the exact settled density. Panning one back into view
// applies the latest density even if the camera hasn't zoomed again.
export function visibleHeaderRaster(initialZoom: number) {
  // Reversing wheel steps can return 1 + floating point noise at 100%.
  const density = (zoom: number) => zoom <= 1 + 1e-6 ? 1 : zoom
  let scale = density(initialZoom)
  let observer: IntersectionObserver | undefined
  const observed = new Set<HTMLElement>()
  const visible = new Set<HTMLElement>()
  const refresh = (header: HTMLElement) => {
    const value = scale === 1 ? '' : String(scale)
    if (header.style.getPropertyValue('--st-header-scale') !== value)
      header.style.setProperty('--st-header-scale', value)
  }
  return {
    observe(header: HTMLElement) {
      observer ??= new IntersectionObserver(entries => {
        for (const entry of entries) {
          const element = entry.target as HTMLElement
          if (!observed.has(element)) continue
          if (entry.isIntersecting) {
            visible.add(element)
            refresh(element)
          } else visible.delete(element)
        }
      }, { root: header.closest('.react-flow') })
      observed.add(header)
      observer.observe(header)
      return () => {
        observed.delete(header)
        visible.delete(header)
        observer?.unobserve(header)
        if (!observed.size) {
          observer?.disconnect()
          observer = undefined
        }
      }
    },
    settle(zoom: number) {
      const next = density(zoom)
      if (next === scale) return
      scale = next
      visible.forEach(refresh)
    },
  }
}
