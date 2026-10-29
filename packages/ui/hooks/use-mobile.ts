import * as React from "react"

const MOBILE_BREAKPOINT = 768
// Tailwind `xl`. Below it the app can no longer seat three columns at a
// readable width: a 256px nav plus the chat rail's 320px leaves the reading
// surface under ~500px at 1024–1279, which is what made the chat rail and the
// conversation body read cramped on a 1039px viewport. Those surfaces fold to
// the single column phones already get, and the nav becomes a sheet, so the
// list or the conversation owns the full width instead of sharing it three ways.
const COMPACT_BREAKPOINT = 1280

function useIsBelow(breakpoint: number) {
  const [isBelow, setIsBelow] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const onChange = () => {
      setIsBelow(window.innerWidth < breakpoint)
    }
    mql.addEventListener("change", onChange)
    setIsBelow(window.innerWidth < breakpoint)
    return () => mql.removeEventListener("change", onChange)
  }, [breakpoint])

  return !!isBelow
}

export function useIsMobile() {
  return useIsBelow(MOBILE_BREAKPOINT)
}

export function useIsCompact() {
  return useIsBelow(COMPACT_BREAKPOINT)
}
