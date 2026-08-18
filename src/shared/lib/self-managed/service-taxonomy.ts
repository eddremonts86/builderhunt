/**
 * What a self-managed profile may say it offers (plan: phase-2/07-perfiles-autogestionados).
 *
 * Languages and topics stay free text because reality does not fit a list. Services do not: a
 * closed set is what lets search filter on them at all. Left open, every person invents their own
 * word for the same work — "traducción", "translation", "traducciones EN>ES" — and the filter that
 * was the point of the field matches none of them.
 *
 * ## Only the id is stored
 *
 * The label is resolved at render. A label is presentation and may change freely; an id is a value
 * in a database row and changing it rewrites history. This is the same split `USER_SEGMENT_COPY`
 * makes against `USER_SEGMENTS`, for the same reason.
 *
 * ## The version is not decoration
 *
 * `SERVICE_TAXONOMY_VERSION` is bumped only when an id's *meaning* changes. Adding an entry is not a
 * bump; renaming a label is not a bump. A row written under version 1 means what version 1 meant,
 * forever — which is what makes a later reinterpretation an explicit migration rather than a silent
 * reinterpretation of everybody's profile.
 */
export const SERVICE_TAXONOMY_VERSION = 1

export interface ServiceDefinition {
  readonly id: string
  /** Spanish, because these are the words the people offering the work use for it. */
  readonly label: string
  /** Only translation has a meaningful sub-kind today; the field stays optional rather than empty. */
  readonly allowedKinds?: readonly string[]
}

export const SERVICE_TAXONOMY: readonly ServiceDefinition[] = [
  { id: 'translation', label: 'Traducción', allowedKinds: ['es-en', 'en-es', 'fr-en', 'en-fr', 'es-fr', 'fr-es', 'multilingual'] },
  { id: 'copywriting', label: 'Redacción y copy' },
  { id: 'technical-writing', label: 'Documentación técnica' },
  { id: 'editing-proofreading', label: 'Edición y corrección' },
  { id: 'localization', label: 'Localización' },
  { id: 'transcription', label: 'Transcripción' },
  { id: 'interpretation', label: 'Interpretación' },
  { id: 'illustration', label: 'Ilustración' },
  { id: 'photography', label: 'Fotografía' },
  { id: 'video-editing', label: 'Edición de vídeo' },
  { id: 'design-product', label: 'Diseño de producto' },
  { id: 'design-graphic', label: 'Diseño gráfico' },
  { id: 'ux-research', label: 'Investigación UX' },
  { id: 'data-analysis', label: 'Análisis de datos' },
  { id: 'consulting', label: 'Consultoría' },
  { id: 'community-management', label: 'Gestión de comunidad' },
  { id: 'legal-tech', label: 'Asesoría legal tech' },
  { id: 'tax-finance', label: 'Asesoría fiscal y financiera' },
  { id: 'coaching-mentoring', label: 'Mentoría y coaching' },
  { id: 'other', label: 'Otro (describir en bio)' },
] as const

export const SERVICE_IDS = SERVICE_TAXONOMY.map((service) => service.id)

const BY_ID = new Map(SERVICE_TAXONOMY.map((service) => [service.id, service]))

/** Total: an unknown id is `null`, never a throw, because it arrives from a database row. */
export function serviceById(id: string): ServiceDefinition | null {
  return BY_ID.get(id) ?? null
}

/**
 * The label to render, falling back to the stored id.
 *
 * A row can outlive its definition — a taxonomy entry removed in a later version leaves rows behind
 * — and showing the raw id is honest where showing nothing would silently drop a service the person
 * chose.
 */
export function serviceLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id
}

export function isKnownService(id: string): boolean {
  return BY_ID.has(id)
}
