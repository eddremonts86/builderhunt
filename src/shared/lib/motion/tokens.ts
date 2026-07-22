/** Shared duration/easing so every animated piece of the dashboard shell feels consistent. */
export const motionTokens = {
  duration: {
    fast: 0.18,
    normal: 0.32,
    slow: 0.5,
  },
  easing: {
    smooth: [0.22, 1, 0.36, 1] as [number, number, number, number],
    sharp: [0.4, 0, 0.2, 1] as [number, number, number, number],
  },
  distance: {
    sm: 6,
    md: 12,
    lg: 24,
  },
} as const

export const fadeInUp = {
  initial: { opacity: 0, y: motionTokens.distance.md },
  animate: { opacity: 1, y: 0 },
  transition: { duration: motionTokens.duration.normal, ease: motionTokens.easing.smooth },
}

/** Variants (hidden/visible) form of `fadeInUp`, for use as a child of `staggerContainer`. */
export const fadeInUpVariants = {
  hidden: { opacity: 0, y: motionTokens.distance.md },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: motionTokens.duration.normal, ease: motionTokens.easing.smooth },
  },
}

export const staggerContainer = (staggerChildren = 0.06) => ({
  hidden: {},
  visible: { transition: { staggerChildren } },
})
