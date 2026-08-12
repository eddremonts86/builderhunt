interface IdentityCellProps {
  name: string
  /**
   * The second line: an email, a handle, a role.
   *
   * On the same line as the name, not in a column of its own. A separate Email column doubles the
   * table's width to repeat information nobody sorts or filters by, and it is the first column to
   * be squeezed to nothing on a laptop.
   */
  meta?: string
  /** 26px, or the initials fallback when there is none. */
  avatarUrl?: string | null
}

/**
 * A 26px avatar beside a name, with the person's second identifier under it.
 *
 * The avatar is `alt=""` on purpose. It is decorative *here* — the name is right beside it in text,
 * so alt text would make a screen reader announce the same person twice. That is the opposite of
 * the rule everywhere else in the app, and it is the correct reading of WCAG 1.1.1: an image whose
 * information is already available in adjacent text is decorative by definition.
 *
 * Rows carrying one of these want `density="lg"` (64px) — the reference's identity density. At
 * `md` the avatar and two lines of text do not fit, and the row grows past the height the
 * virtualizer is offsetting by.
 */
export function IdentityCell({ name, meta, avatarUrl }: IdentityCellProps) {
  return (
    <div className="tbl-identity" data-testid="cell-identity">
      {avatarUrl
        ? <img className="tbl-avatar" src={avatarUrl} alt="" loading="lazy" width={26} height={26} />
        : <span className="tbl-avatar tbl-avatar-fallback" aria-hidden="true">{initials(name)}</span>}
      <div className="min-w-0">
        <div className="tbl-cell-primary" title={name}>{name}</div>
        {meta !== undefined && meta !== '' && (
          <div className="tbl-cell-meta" title={meta} data-testid="cell-identity-meta">{meta}</div>
        )}
      </div>
    </div>
  )
}

/** Up to two letters, from the first and last word. `Ana` gives `A`, `Ana Ruiz` gives `AR`. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0][0] ?? ''
  const last = words.length > 1 ? words[words.length - 1][0] ?? '' : ''
  return (first + last).toUpperCase()
}
