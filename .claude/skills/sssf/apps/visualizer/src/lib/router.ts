import { ref } from 'vue'

// Hash routes:
//   #/ → factory sessions · #/<adw_id> → waterfall · #/<adw_id>/<phase_id> → phase panel
//   #/live → live monitor · #/live/<source>/<id> → live session detail
export interface Route {
  view: 'factory' | 'live'
  adwId: string | null
  phaseId: string | null
  liveSource: string | null
  liveId: string | null
}

function parse(): Route {
  const parts = window.location.hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent)
  if (parts[0] === 'live') {
    return {
      view: 'live',
      adwId: null,
      phaseId: null,
      liveSource: parts[1] ?? null,
      liveId: parts[2] ?? null,
    }
  }
  return {
    view: 'factory',
    adwId: parts[0] ?? null,
    phaseId: parts[1] ?? null,
    liveSource: null,
    liveId: null,
  }
}

const route = ref<Route>(parse())

window.addEventListener('hashchange', () => {
  route.value = parse()
})

export function useRoute() {
  return route
}

// Display name for the phase crumb — set by the trace view once phases load,
// since the phase_id in the URL is not the display name.
export const phaseCrumb = ref<string | null>(null)

export function hrefFor(adwId?: string | null, phaseId?: string | null): string {
  let h = '#/'
  if (adwId) h += encodeURIComponent(adwId)
  if (adwId && phaseId) h += `/${encodeURIComponent(phaseId)}`
  return h
}

export function navigate(adwId?: string | null, phaseId?: string | null): void {
  window.location.hash = hrefFor(adwId, phaseId)
}

export function liveHref(source?: string | null, id?: string | null): string {
  let h = '#/live'
  if (source && id) h += `/${encodeURIComponent(source)}/${encodeURIComponent(id)}`
  return h
}

export function navigateLive(source?: string | null, id?: string | null): void {
  window.location.hash = liveHref(source, id)
}
