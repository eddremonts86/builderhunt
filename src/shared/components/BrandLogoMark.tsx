/** The BuilderHunt glyph, shared by every floating topbar so it's pixel-for-pixel
 * identical everywhere instead of two near-duplicate copies drifting apart. */
export function BrandLogoMark({ size = 22 }: { size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-md shrink-0"
      style={{ width: size, height: size, background: 'linear-gradient(135deg, #6366f1, #4f46e5)' }}
      aria-hidden="true"
    >
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none">
        <path d="M5 4h7a4 4 0 0 1 4 4v1" stroke="white" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M16 4h3a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-7a4 4 0 0 0-4 4v3" stroke="white" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M8 20H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h7a4 4 0 0 0 4-4V7" stroke="white" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="11" cy="12" r="1.9" fill="#06b6d4" />
      </svg>
    </span>
  )
}
