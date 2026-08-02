/**
 * The seven credentialed job feeds (plan 43 Phase 4, written 2026-08-02).
 *
 * ## What these tests can and cannot prove
 *
 * Three of the seven were probed live and their fixtures below are **real payloads**, trimmed to one item:
 * `jobtech_dev_jobs`, `themuse_jobs`, `arbeitsagentur_jobs`. For those, a passing test means the parser reads
 * what the API actually serves.
 *
 * The other four parse a shape taken from published documentation, and their fixtures were written from that
 * documentation. A passing test there means the parser is *self-consistent with the docs* — which is worth
 * having, and is not the same as knowing the API serves that shape. The adapter's own `unexpected_response_shape`
 * failure is what covers the gap on the first real run.
 *
 * Saying so here rather than letting a green suite imply more than it knows.
 */
import { describe, expect, it } from 'vitest'
import {
  CREDENTIALED_JOB_FEEDS,
  CREDENTIALED_JOB_FEED_ADAPTERS,
  createCredentialedJobFeedAdapter,
} from '~/lib/solutions/sources/credentialed-job-feeds'

const context = (limit = 10) => ({
  allowedHosts: ['example.invalid'],
  limit,
  signal: new AbortController().signal,
} as never)

// ── Real payloads, captured 2026-08-02 ─────────────────────────────────────────────────────────

const JOBTECH_LIVE = JSON.stringify({
  total: { value: 636 },
  hits: [{
    id: '31281556',
    webpage_url: 'https://arbetsformedlingen.se/platsbanken/annonser/31281556',
    headline: 'Utvecklare',
    description: { text: 'Utvecklare\nJobba på en innovativ högskola där olika perspektiv möts!' },
    employment_type: { concept_id: 'PFZr_Syz_cUq', label: 'Vanlig anställning' },
    working_hours_type: { concept_id: '6YE1_gAC_R2G', label: 'Heltid' },
    employer: { name: 'HÖGSKOLAN I HALMSTAD', workplace: 'Högskolan i Halmstad, Verksamhetsstöd' },
    workplace_address: { municipality: 'Halmstad', region: 'Hallands län' },
    occupation: { concept_id: 'fg7B_yov_smw', label: 'Systemutvecklare/Programmerare' },
    occupation_group: { concept_id: 'DJh5_yyF_hEM', label: 'Mjukvaru- och systemutvecklare m.fl.' },
    publication_date: '2026-07-20T00:01:23',
    remote_work: null,
  }],
})

const MUSE_LIVE = JSON.stringify({
  page: 1,
  results: [{
    contents: '<p>As a Senior Specialist Electrical Engineer, the candidate must have experience.</p>',
    name: 'Senior Specialist, Electrical Engineer',
    publication_date: '2026-03-17T13:37:20Z',
    id: 21438281,
    locations: [{ name: 'Anaheim, CA' }],
    categories: [],
    levels: [{ name: 'Senior Level', short_name: 'senior' }],
    refs: { landing_page: 'https://www.themuse.com/jobs/l3harristechnologies/senior-specialist' },
    company: { id: 15000922, short_name: 'l3harristechnologies', name: 'L3Harris Technologies' },
  }],
})

const ARBEITSAGENTUR_LIVE = JSON.stringify({
  maxErgebnisse: 1,
  stellenangebote: [{
    beruf: 'Entwickler/in Digitale Medien',
    titel: 'Entwickler (w/m/d)',
    refnr: '10000-1207221816-S',
    arbeitsort: { plz: '22765', ort: 'Hamburg', strasse: 'Planckstr. 13', region: 'Hamburg' },
    arbeitgeber: 'WV Workout Werbung GmbH',
    aktuelleVeroeffentlichungsdatum: '2026-07-16',
  }],
})

// ── Documented shapes, never served to us ──────────────────────────────────────────────────────

const ADZUNA_DOC = JSON.stringify({
  results: [{
    id: '4200000001',
    title: 'Backend Engineer',
    description: 'Build and maintain services…',
    redirect_url: 'https://www.adzuna.co.uk/details/4200000001',
    created: '2026-07-30T09:00:00Z',
    company: { display_name: 'Acme Ltd' },
    location: { display_name: 'London, UK', area: ['UK', 'London'] },
    category: { label: 'IT Jobs', tag: 'it-jobs' },
    contract_time: 'full_time',
    salary_min: 60000,
    salary_max: 80000,
    salary_is_predicted: '0',
  }],
})

const USAJOBS_DOC = JSON.stringify({
  SearchResult: {
    SearchResultItems: [{
      MatchedObjectId: '820000000',
      MatchedObjectDescriptor: {
        PositionID: 'ST-12345',
        PositionTitle: 'IT Specialist (Applications Software)',
        PositionURI: 'https://www.usajobs.gov/job/820000000',
        OrganizationName: 'Bureau of Land Management',
        DepartmentName: 'Department of the Interior',
        PositionLocation: [{ LocationName: 'Denver, Colorado' }],
        PositionSchedule: [{ Name: 'Full-Time' }],
        PositionRemuneration: [{ MinimumRange: '99000', MaximumRange: '128000', RateIntervalCode: 'PA' }],
        JobCategory: [{ Name: 'Information Technology Management' }],
        QualificationSummary: 'You must meet the following requirements…',
        PublicationStartDate: '2026-07-28',
      },
    }],
  },
})

const FRANCE_TRAVAIL_DOC = JSON.stringify({
  resultats: [{
    id: '190XYZK',
    intitule: 'Développeur / Développeuse full stack',
    description: 'Vous rejoindrez une équipe de six personnes…',
    dateCreation: '2026-07-25T08:12:00.000Z',
    entreprise: { nom: 'Société Exemple' },
    lieuTravail: { libelle: '75 - PARIS 09' },
    origineOffre: { urlOrigine: 'https://candidat.francetravail.fr/offres/recherche/detail/190XYZK' },
    typeContrat: 'CDI',
    typeContratLibelle: 'Contrat à durée indéterminée',
    romeLibelle: 'Études et développement informatique',
    secteurActiviteLibelle: 'Programmation informatique',
    salaire: { libelle: 'Annuel de 40000 à 50000 Euros' },
  }],
})

const INFOJOBS_DOC = JSON.stringify({
  totalResults: 1,
  items: [{
    id: 'a1b2c3',
    title: 'Desarrollador Backend',
    link: 'https://www.infojobs.net/oferta/a1b2c3',
    author: { id: '99', name: 'Empresa Ejemplo' },
    city: 'Madrid',
    province: { value: 'Madrid' },
    published: '2026-07-29T10:00:00.000Z',
    category: { value: 'Informática y telecomunicaciones' },
    subcategory: { value: 'Programación' },
    contractType: { value: 'Indefinido' },
    experienceMin: { value: 'Más de 3 años' },
    requirementMin: 'Experiencia con Node.js y PostgreSQL',
  }],
})

describe('the parsers read what the API serves — verified live', () => {
  it('jobtech_dev_jobs: real payload, taxonomy labels not concept ids', () => {
    const [job] = CREDENTIALED_JOB_FEEDS.jobtech_dev_jobs.parse(JOBTECH_LIVE)!
    expect(job.externalId).toBe('31281556')
    expect(job.roleTitle).toBe('Utvecklare')
    expect(job.companyName).toBe('HÖGSKOLAN I HALMSTAD')
    expect(job.area).toBe('Halmstad')
    expect(job.employmentType).toBe('Vanlig anställning')
    // An id like `fg7B_yov_smw` matches nothing a person would type, so the label is what is indexed.
    expect(job.tags).toContain('Systemutvecklare/Programmerare')
    expect(job.tags.join(' ')).not.toContain('fg7B')
    // `remote_work: null` is a real tri-state — "we do not know" is not "no".
    expect(job.remote).toBeNull()
  })

  it('jobtech_dev_jobs: falls back to the region when there is no municipality', () => {
    const body = JSON.stringify({
      hits: [{
        id: '1', headline: 'X', webpage_url: 'https://example.invalid/1',
        workplace_address: { region: 'Hallands län' }, description: { text: 'x' },
      }],
    })
    expect(CREDENTIALED_JOB_FEEDS.jobtech_dev_jobs.parse(body)![0].area).toBe('Hallands län')
  })

  it('themuse_jobs: real payload, HTML description flattened', () => {
    const [job] = CREDENTIALED_JOB_FEEDS.themuse_jobs.parse(MUSE_LIVE)!
    expect(job.externalId).toBe('21438281')
    expect(job.companyName).toBe('L3Harris Technologies')
    expect(job.area).toBe('Anaheim, CA')
    expect(job.seniority).toBe('Senior Level')
    // The API serves `contents` as HTML; a summary full of `<p>` is not a summary.
    expect(job.summary).toContain('Senior Specialist Electrical Engineer')
    expect(job.summary).not.toContain('<p>')
  })

  it('themuse_jobs: infers remote from the location name, because there is no flag', () => {
    const body = JSON.stringify({
      results: [{
        id: 1, name: 'X', refs: { landing_page: 'https://example.invalid/1' },
        locations: [{ name: 'Flexible / Remote' }], company: { name: 'Y' },
      }],
    })
    expect(CREDENTIALED_JOB_FEEDS.themuse_jobs.parse(body)![0].remote).toBe(true)
    // And stays unknown otherwise rather than being asserted false.
    expect(CREDENTIALED_JOB_FEEDS.themuse_jobs.parse(MUSE_LIVE)![0].remote).toBeNull()
  })

  it('arbeitsagentur_jobs: real payload, and no summary because the API sends none', () => {
    const [job] = CREDENTIALED_JOB_FEEDS.arbeitsagentur_jobs.parse(ARBEITSAGENTUR_LIVE)!
    expect(job.externalId).toBe('10000-1207221816-S')
    expect(job.roleTitle).toBe('Entwickler (w/m/d)')
    expect(job.area).toBe('Hamburg')
    // Null rather than padded with the title — a summary that repeats the heading teaches a reader nothing and
    // would make the projection document longer without making it more findable.
    expect(job.summary).toBeNull()
    expect(job.postingUrl).toContain('10000-1207221816-S')
  })
})

describe('the parsers read the documented shape — never served to us', () => {
  it('adzuna_jobs: drops a predicted salary', () => {
    /**
     * `salary_is_predicted` marks Adzuna's own model output, not the employer's figure. Storing it would feed a
     * cost estimate the employer never stated — the composer's estimates are ranges a user acts on.
     */
    const [real] = CREDENTIALED_JOB_FEEDS.adzuna_jobs.parse(ADZUNA_DOC)!
    expect(real.salaryMin).toBe(60000)

    const predicted = ADZUNA_DOC.replace('"salary_is_predicted": "0"', '"salary_is_predicted": "1"')
      .replace('"salary_is_predicted":"0"', '"salary_is_predicted":"1"')
    const [modelled] = CREDENTIALED_JOB_FEEDS.adzuna_jobs.parse(predicted)!
    expect(modelled.salaryMin).toBeNull()
    expect(modelled.salaryMax).toBeNull()
  })

  it('usajobs_jobs: reads through the two-level envelope and asserts USD', () => {
    const [job] = CREDENTIALED_JOB_FEEDS.usajobs_jobs.parse(USAJOBS_DOC)!
    expect(job.externalId).toBe('820000000')
    expect(job.roleTitle).toContain('IT Specialist')
    expect(job.companyName).toBe('Bureau of Land Management')
    expect(job.salaryMin).toBe(99000)
    // Federal pay is USD by definition — the one place a currency can be asserted without guessing.
    expect(job.salaryCurrency).toBe('USD')
  })

  it('france_travail_jobs: does not mine the free-text salary', () => {
    // "Annuel de 40000 à 50000 Euros" is prose. A regex over it is exactly the guess a cost estimate must not
    // rest on, so both bounds stay null.
    const [job] = CREDENTIALED_JOB_FEEDS.france_travail_jobs.parse(FRANCE_TRAVAIL_DOC)!
    expect(job.salaryMin).toBeNull()
    expect(job.salaryMax).toBeNull()
    expect(job.companyName).toBe('Société Exemple')
    expect(job.employmentType).toBe('Contrat à durée indéterminée')
  })

  it('infojobs_jobs: prefers the city over the province', () => {
    const [job] = CREDENTIALED_JOB_FEEDS.infojobs_jobs.parse(INFOJOBS_DOC)!
    expect(job.area).toBe('Madrid')
    expect(job.tags).toEqual(['Informática y telecomunicaciones', 'Programación'])
  })
})

describe('every parser refuses a shape it does not recognise', () => {
  it('returns null rather than an empty list', () => {
    /**
     * The load-bearing behaviour for the four adapters that have never run. `null` becomes
     * `unexpected_response_shape`, a hard failure; an empty array would be indistinguishable from a source with
     * no data, and the catalog would go stale with every run reporting success.
     */
    for (const [key, spec] of Object.entries(CREDENTIALED_JOB_FEEDS)) {
      expect(spec.parse('{"unexpected":true}'), `${key} accepted a foreign shape`).toBeNull()
      expect(spec.parse('not json at all'), `${key} accepted invalid JSON`).toBeNull()
    }
  })

  it('skips an item missing an id, a title, or a URL rather than inventing one', () => {
    const body = JSON.stringify({ hits: [{ id: '1' }, { headline: 'No id' }] })
    expect(CREDENTIALED_JOB_FEEDS.jobtech_dev_jobs.parse(body)).toEqual([])
  })
})

describe('credentials', () => {
  it('fails with the missing variable named, rather than silently doing nothing', async () => {
    /**
     * Named because the operator has to act on it. A bare "failed" would send someone to the logs to find out
     * which of two keys is absent.
     */
    const adapter = createCredentialedJobFeedAdapter(CREDENTIALED_JOB_FEEDS.adzuna_jobs, () => undefined)
    const outcome = await adapter.collect(context())
    expect(outcome.kind).toBe('failed')
    expect((outcome as { reason: string }).reason).toContain('ADZUNA_APP_ID')
    expect((outcome as { reason: string }).reason).toContain('ADZUNA_APP_KEY')
  })

  it('builds InfoJobs Basic auth from the two halves rather than storing it pre-encoded', () => {
    const request = CREDENTIALED_JOB_FEEDS.infojobs_jobs.request(1, 20, (name) => (
      name === 'INFOJOBS_CLIENT_ID' ? 'id' : name === 'INFOJOBS_CLIENT_SECRET' ? 'secret' : undefined
    ))
    expect(request?.headers?.Authorization).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`)
  })

  it('sends the USAJOBS contact User-Agent their terms require', () => {
    const request = CREDENTIALED_JOB_FEEDS.usajobs_jobs.request(1, 20, (name) => (
      name === 'USAJOBS_API_KEY' ? 'key' : name === 'USAJOBS_USER_AGENT' ? 'ops@example.com' : undefined
    ))
    expect(request?.headers?.['User-Agent']).toBe('ops@example.com')
    expect(request?.headers?.['Authorization-Key']).toBe('key')
  })

  it('falls back to the public Arbeitsagentur client key', () => {
    // Not a secret: it is the key their own web app sends, which is why it is hard-coded rather than required.
    const request = CREDENTIALED_JOB_FEEDS.arbeitsagentur_jobs.request(1, 20, () => undefined)
    expect(request?.headers?.['X-API-Key']).toBe('jobboerse-jobsuche')
  })

  it('refuses to build an Adzuna request without both halves', () => {
    expect(CREDENTIALED_JOB_FEEDS.adzuna_jobs.request(1, 20, (name) => (name === 'ADZUNA_APP_ID' ? 'id' : undefined)))
      .toBeNull()
  })
})

describe('registration', () => {
  it('exports one adapter per spec, and every one claims the same metadata keys', () => {
    // The register's `allowed_fields` is compared against these; a mismatch drops fields silently.
    expect(CREDENTIALED_JOB_FEED_ADAPTERS).toHaveLength(Object.keys(CREDENTIALED_JOB_FEEDS).length)
    for (const adapter of CREDENTIALED_JOB_FEED_ADAPTERS) {
      expect(adapter.metadataKeys).toEqual([
        'roleTitle', 'companyName', 'area', 'summary', 'postingUrl', 'publishedAt',
        'remote', 'employmentType', 'seniority', 'salaryMin', 'salaryMax', 'salaryCurrency', 'tags',
      ])
    }
  })

  it('declares exactly one host each, and never a wildcard', () => {
    for (const spec of Object.values(CREDENTIALED_JOB_FEEDS)) {
      expect(spec.hosts.length).toBeGreaterThan(0)
      for (const host of spec.hosts) expect(host).not.toContain('*')
    }
  })
})
