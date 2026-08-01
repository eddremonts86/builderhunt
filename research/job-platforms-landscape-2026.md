# Job Platforms & Professional Networks — Landscape 2026

> **Última actualización:** agosto 2026
> **Alcance:** Alternativas a LinkedIn y JobIndex, con foco en Europa (especialmente España, DACH, Francia, Países Bajos, UK y Escandinavia)
> **Incluye:** APIs públicas, scrapers de terceros, viabilidad legal, jurisprudencia, snippets de código

---

## Índice

1. [Resumen ejecutivo](#resumen-ejecutivo)
2. [Cambios importantes desde 2023](#cambios-importantes-desde-2023)
3. [Tier A — Plataformas con API pública usable hoy](#tier-a--plataformas-con-api-pública-usable-hoy)
4. [Tier B — Plataformas con API restringida o muerta](#tier-b--plataformas-con-api-restringida-o-muerta)
5. [Tier C — Sin API pero scrapeable legalmente](#tier-c--sin-api-pero-scrapable-legalmente)
6. [Tier D — Prohibidas o de altísimo riesgo](#tier-d--prohibidas-o-de-altísimo-riesgo)
7. [Marco legal 2026 (US + EU)](#marco-legal-2026-us--eu)
8. [Snippets de código listos para usar](#snippets-de-código-listos-para-usar)
9. [Recomendación final — Stack mínimo viable](#recomendación-final--stack-mínimo-viable)
10. [Fuentes y referencias](#fuentes-y-referencias)

---

## Resumen ejecutivo

El panorama de plataformas de empleo y redes profesionales en 2026 es **mucho más cerrado** que hace cinco años. Casi todas las APIs públicas de lectura de datos han muerto o se han convertido en productos enterprise. La realidad hoy:

- **6–8 plataformas tienen API pública útil** (Adzuna, InfoJobs, Arbeitnow, RemoteOK, Remotive, Jobicy, Himalayas, France Travail, GitHub REST).
- **Las grandes (LinkedIn, Indeed, Glassdoor, Wellfound, StepStone) han cerrado o restringido drásticamente sus APIs de lectura**. La única vía para extraer datos es scraping, con riesgo legal variable.
- **El scraping de datos públicos es legal en US y EU** post *hiQ v. LinkedIn* y *Meta v. Bright Data*, pero GDPR + ToS + AI Act elevan la vara para uso comercial.
- **Los agregadores de terceros** (Apify, Bright Data, JobsPipe, Parse.bot, Techmap, Scrappa) han ocupado el vacío y ofrecen APIs normalizadas de pago.

Si quieres un **stack 100% legal y gratis** hoy, puedes cubrir ≈80% del mercado europeo con cinco llamadas.

---

## Cambios importantes desde 2023

| Plataforma | Qué cambió | Cuándo | Impacto |
|---|---|---|---|
| **Indeed Job Search API** | Deprecada y cerrada | Mayo 2021 | Obligatorio scrapear o usar partner program |
| **Glassdoor Partner API** | Cerrada sin reemplazo | 2022–2023 | Imposible leer reviews/salarios por API |
| **LinkedIn Sales Navigator API** | Cerrada a nuevos partners | 2023 | Solo SNAP legacy mantiene acceso |
| **LinkedIn Marketing API** | Aprobación caso a caso | 2023+ | Sin precio público, weeks-to-months wait |
| **Indeed Publisher API** | Cerrada, reemplazada por widget iframe | 2024 | Sin extracción de datos, solo embed |
| **GitHub Jobs** | Sitio y API cerradas | 2021 | El "CV vivo" de devs sigue vía `api.github.com` |
| **AngelList Talent → Wellfound** | API deprecada, spinoff | 2022 | Web app Apollo GraphQL con DataDome |
| **Otta → Welcome to the Jungle** | Fusión, sin API pública | 2024 | Solo scraping con bypass de Cloudflare |
| **Stack Overflow Jobs** | Cerrado | 2022 | Solo red Q&A |
| **StepStone** | Sin API pública | histórico | Solo scraping con throttle agresivo |
| **Xing API** | Solo E-Recruiting | 2024+ | Perfiles/network no accesibles por API |
| **EURES** | T&C prohíbe explícitamente scraping | 2024+ | API solo para NCOs (gobiernos nacionales) |
| **Jobnet.dk** | RSS de saved search deprecado | 2024 | Solo JobannonceService B2B |
| **AI Act EU** | Entra en vigor | ago 2025 | Si scraped data alimenta decisiones de hiring, hay compliance extra |

---

## Tier A — Plataformas con API pública usable hoy

### 1. Adzuna

- **Sitio:** https://adzuna.com
- **Docs:** https://developer.adzuna.com
- **Auth:** `app_id` + `app_key` (registro gratuito)
- **Tier gratis:** ≈1.000 calls/mes
- **Cobertura:** 16+ países (UK, DE, FR, ES, IT, NL, AT, BE, PL, US, AU, NZ, IN, CA, CH, SG)
- **Endpoints destacados:**
  - `GET /v1/api/jobs/{country}/search/{page}` — listings con salario estructurado
  - `GET /v1/api/jobs/{country}/count` — conteo
  - `GET /v1/api/jobs/{country}/histogram` — distribución salarial
  - `GET /v1/api/jobs/{country}/salary_history` — series temporales
  - `GET /v1/api/jobs/{country}/top_companies`
  - `GET /v1/api/jobs/{country}/sectors`
- **Limitaciones:** Descripción truncada, salario a veces predicho (flag `salary_is_predicted`).
- **Ideal para:** dashboards de mercado laboral, salary benchmarking, job alerts.

```bash
curl "https://api.adzuna.com/v1/api/jobs/gb/search/1?\
app_id=YOUR_APP_ID&app_key=YOUR_APP_KEY&\
what=python%20developer&where=london&\
results_per_page=20&full_time=1&permanent=1&\
content-type=application/json"
```

### 2. InfoJobs (España)

- **Sitio:** https://infojobs.net
- **Docs:** https://developer.infojobs.net
- **Auth:** HTTP Basic Auth con `Client ID` + `Client secret` (registro gratis)
- **Tier gratis:** sí, con rate limits
- **Cobertura:** España (40k+ vacantes/día)
- **Endpoints destacados:**
  - `GET /api/9/offer` — listado con facets (provincia, categoría, contrato, salario)
  - `GET /api/9/offer/{offerId}` — detalle completo
  - `GET /api/9/dictionary/{dictionaryId}` — provincias, categorías, skills
  - `GET /api/9/candidate/...` (con OAuth candidato) — perfil, CV, applications
  - `POST /api/9/offer/{offerId}/application` (con OAuth candidato) — apply
- **Ideal para:** scraping del mercado español, integración con ATS.

```bash
curl -u "$CLIENT_ID:$CLIENT_SECRET" \
  "https://api.infojobs.net/api/9/offer?keyword=python&province=Madrid&maxResults=20"
```

Wrapper Node: https://github.com/AlvaroBernalG/infojobs

### 3. Arbeitnow (Europa/Remote)

- **Sitio:** https://arbeitnow.com
- **Docs:** https://www.arbeitnow.com/blog/job-board-api
- **Auth:** **ninguna** (público)
- **Tier gratis:** ilimitado (sin auth, sin key)
- **Cobertura:** Europa + remote, foco en tech y roles con visa sponsorship
- **Endpoint:**
  - `GET https://arbeitnow.com/api/job-board-api` — feed completo con campos `title`, `company_name`, `location`, `remote`, `tags`, `url`, `date`
  - Query params: `visa_sponsorship=true|false`
- **Ideal para:** arranque sin fricción, integración de remote jobs, filtro visa.

```bash
curl "https://arbeitnow.com/api/job-board-api?visa_sponsorship=true"
```

### 4. RemoteOK

- **Sitio:** https://remoteok.com
- **Endpoint:** `GET https://remoteok.com/api`
- **Auth:** ninguna
- **CORS:** abierto
- **Tier gratis:** ilimitado
- **Cobertura:** solo remote
- **Notas:** requiere atribución con link back en T&C; data se actualiza constante.
- **Ideal para:** feeds de remote jobs, agregadores minimalistas.

### 5. Remotive

- **Sitio:** https://remotive.com
- **Endpoint:** `GET https://remotive.com/api/remote-jobs`
- **Auth:** ninguna
- **Tier gratis:** sí
- **Cobertura:** remote, curado
- **Categorías:** `software-dev`, `customer-support`, `design`, `marketing`, `sales`, etc.

### 6. Jobicy

- **Sitio:** https://jobicy.com
- **Endpoint:** REST JSON público
- **Auth:** ninguna
- **Tier gratis:** sí
- **Cobertura:** remote generalista

### 7. Himalayas

- **Sitio:** https://himalayas.app
- **Endpoint:** REST JSON público
- **Auth:** ninguna
- **Tier gratis:** sí
- **Cobertura:** remote, curado

### 8. The Muse

- **Sitio:** https://themuse.com
- **Auth:** `apiKey`
- **Tier gratis:** sí
- **Cobertura:** US/UK/CA, perfiles de empresa muy ricos
- **Bonus:** datos de cultura, beneficios, valores

### 9. USAJOBS (US Federal)

- **Sitio:** https://usajobs.gov
- **Endpoint:** REST oficial (`https://developer.usajobs.gov/`)
- **Auth:** API key con header `Authorization-Key`
- **Tier gratis:** sí
- **Cobertura:** solo US federal

### 10. France Travail (ex Pôle Emploi)

- **Sitio:** https://francetravail.fr
- **Docs:** https://www.francetravail.io
- **Auth:** OAuth2
- **Tier gratis:** sí, con registro
- **Cobertura:** Francia completa, público + privado
- **Endpoints destacados:**
  - Offres d'emploi (search por ROME code, location, contract type)
  - Référentiel (skills, ROME, NAF)
  - Données marché travail (estadísticas)
- **Ideal para:** mercado francés oficial, máximo rigor en PII handling.

### 11. JobTech Dev (Suecia)

- **Sitio:** https://jobtechdev.se
- **Auth:** API key
- **Tier gratis:** sí
- **Cobertura:** Suecia, 50–80k jobs
- **Endpoints:**
  - `GET /jobs` — búsqueda con filtros
  - `GET /jobs/{id}` — detalle
  - Historial de hasta 12 meses
- **Ideal para:** mercado sueco, datos históricos de hiring.

### 12. Arbeitsagentur / Bundesagentur für Arbeit (Alemania)

- **Sitio:** https://arbeitsagentur.de
- **Auth:** OAuth2 (cliente-certs para alta escala)
- **Tier gratis:** sí
- **Cobertura:** Alemania, oficial
- **Endpoint estrella:** "Jobboerse" search con todos los filtros de la BA
- **Bonus:** datos de mercado laboral (Klassifikationen, Zeitarbeitsfirmen, etc.)

### 13. EURES (EU, oficial)

- **Sitio:** https://europa.eu/eures
- **Auth:** **solo partners EURES con NCO** (coordinación nacional)
- **Tier gratis:** no para terceros
- **Cobertura:** 27 UE + Islandia/Liechtenstein/Noruega
- **Importante:** los T&C prohíben **explícitamente** screen scraping. Si no eres partner, no toques.
- **API interna:** documentada parcialmente, ejemplos de input API en `github.com/navikt/pam-eures-stilling-eksport` (implementación noruega).

### 14. GitHub REST API

- **Sitio:** https://docs.github.com/en/rest
- **Auth:** ninguna (rate-limited) o token personal (5.000/hr)
- **Tier gratis:** generoso
- **Uso como "red profesional":** perfiles (`/users/{username}`), contribs (`/users/{username}/events`), repos, gists, followers. **No incluye job listings** (Jobs API murió en 2021).
- **Ideal para:** talent sourcing de developers, signals de actividad reciente, project history.

### 15. XING E-Recruiting API (DACH, solo clientes con contrato)

- **Sitio:** https://dev.xing.com
- **Auth:** OAuth 1.0a + consumer key/secret + organization_id + order_id (contrato Xing obligatorio)
- **Tier gratis:** no
- **Cobertura:** Alemania, Austria, Suiza
- **Endpoints:** crear/actualizar/archivar/eliminar ofertas, leer tus propias postings, recibir applications
- **Lo que NO da:** acceso a otros profiles, búsqueda de candidatos, scraping de red. Solo gestión de tus jobs.
- **Bonus:** Google X-ray funciona sobre profiles públicos: `site:xing.com inurl:profile intext:"..."`

### 16. Indeed Hiring Lab API (research)

- **Sitio:** https://docs.indeed.com/hiring-lab-api
- **Auth:** API key por solicitud a `hiring-lab-api@indeed.com`
- **Tier gratis:** sí para research
- **Lo que da:** índices de job postings (nacional/regional/sectorial), wage growth, remote work patterns, AI jobs
- **Lo que NO da:** listings individuales. Es solo data agregada del Hiring Lab.
- **Ideal para:** market intelligence, dashboards de tendencias.

---

## Tier B — Plataformas con API restringida o muerta

### LinkedIn

- **API pública (self-serve, gratis):** solo tres scopes — `profile` (nombre+headline+foto), `email`, `w_member_social` (post en nombre del usuario autenticado). Sin acceso a conexiones, búsqueda de perfiles, directorio de empleados, ni job listings.
- **Marketing Developer Platform (MDP):** paginas, ads, scheduling — partner-gated, sin precio público.
- **Sales Navigator (SNAP):** **cerrada a nuevos partners**. Si no estás dentro, no entras.
- **Talent Solutions / Recruiter API:** partner-gated, contrato negociado caso a caso.
- **Learning API:** partner program o site license.
- **Realidad 2026:** no hay forma legítima de leer profiles, connections o jobs a escala vía API. La única vía es scraping (ver Tier C) con todo el riesgo que implica.

### Indeed

- **Job Search API:** muerta desde mayo 2021. No replacement.
- **Publisher API:** cerrada 2024. Reemplazada por widget iframe embebible, no extracción.
- **Employer / Job Sync API (GraphQL):** solo partners. Permite *publicar* jobs desde tu ATS a Indeed, no leer.
- **Indeed Apply:** entrega applications desde Indeed a tu ATS.
- **Sponsored Jobs API:** agencias de medios, gestión de campañas de pago.
- **Hiring Lab API:** ver Tier A (data agregada, no listings).
- **Realidad 2026:** Indeed no expone búsqueda de jobs. Solo partner program de pago con NDA y mínimos de seis cifras.

### Glassdoor

- **Partner API:** muerta desde 2023, sin reemplazo.
- **Customer Insights (B2B):** suscripción enterprise para HR teams, no para developers.
- **Employer-side:** posting tools, sin extracción de reviews.
- **Realidad 2026:** scraping de páginas públicas es la única vía, con login wall detrás de la mayoría de reviews completas.

### Wellfound (ex AngelList Talent)

- **API pública:** no existe. La antigua AngelList API está deprecada.
- **Web app:** Next.js + Apollo GraphQL. Los datos viajan en el graph state serializado en el HTML. **Detrás de DataDome anti-bot.**
- **Partner program (Wellfound Reach):** B2B, no programático desde sesión generada.
- **Realidad 2026:** scraping funcional pero costoso (CSRF token + DataDome cookie + residential proxy + headless browser). Varios proveedores ofrecen esto como servicio (Apify `skootle/wellfound-jobs-scraper`, $79/1k records).

### StepStone

- **API pública:** no existe.
- **Realidad 2026:** scraping con throttle agresivo y rotación de IPs, o vía agregadores (Scrappa, Parse.bot, Apify `truefetch/stepstone-job-listing`).

### Welcome to the Jungle (ex Otta)

- **API pública:** no existe.
- **Realidad 2026:** scraping funcional, sin Cloudflare fuerte. Datos públicos en HTML, JSON en algunos endpoints internos.

### Viadeo

- **API pública:** históricamente existió, no hay developer portal activo en 2026.
- **Estado de la red:** caída en uso, base de usuarios en francofonía menguante.

### Careerjet

- **API:** de pago, no self-serve.
- **Aggregator:** scrapeable pero con anti-bot básico.

### Reed.co.uk (UK)

- **API:** existe con key, plan de pago.
- **Tier gratis:** limitado.
- **Cobertura:** UK generalista.

### ZipRecruiter (US)

- **API:** existe, pago.
- **Cobertura:** US.

### Monster (US/global)

- **API:** históricamente existió, hoy muy restringida.
- **Realidad 2026:** scraping con cuidado.

---

## Tier C — Sin API pero scrapeable legalmente

> **Disclaimer importante:** esta sección describe viabilidad técnica y legal, no es consejo legal. Para uso comercial o de gran escala, consulta con un abogado especializado en propiedad intelectual y protección de datos de la jurisdicción aplicable.

### Marco de análisis

El análisis de viabilidad se apoya en tres ejes:

1. **Acceso técnico** — ¿los datos son públicos (sin login) y no requieren bypass de anti-bot?
2. **Jurisprudencia** — ¿qué dicen los casos *hiQ v. LinkedIn* (2022) y *Meta v. Bright Data* (2024)?
3. **GDPR / PII** — ¿los datos scraped identifican personas naturales residentes UE?

### Jobindex.dk (Dinamarca, prioridad alta)

- **Estado:** scraping técnicamente viable, sin auth.
- **Riesgo legal:** **bajo para job listings** (no son PII). **medio si extraes datos de empresa + contacto** (entra en GDPR).
- **T&C de Jobindex:** tiene `betingelser?lang=en` y DPO en `dpo@jobindex.dk`. Recomiendan revisión caso a caso.
- **GDPR:** Dinamarca aplica GDPR directamente. Si scraped data se cruza con personas, hay obligaciones.
- **Scrapers públicos disponibles:**
  - Apify `blackfalcondata/jobindex-scraper`
  - Apify `studio-amba/jobindex-scraper`
  - Apify `lexis-solutions/jobindex-dk-scraper` ($39/mes)
- **Volumen de datos:** ~80% del mercado laboral danés según Jobindex.
- **Recomendación:** scraping con throttle (1–2 req/seg), respeto de robots.txt, sin almacenamiento permanente, sin reventa sin base legal.

### Jobnet.dk (Dinamarca, portal público oficial)

- **Estado:** scraping técnicamente posible con cuidado.
- **Riesgo legal:** **medio-alto**. Jobnet es portal del Danish Agency for Labour Market and Recruitment (STAR). El RSS de saved searches fue deprecado en 2024.
- **JobannonceService:** API B2B para que operadores de job boards sincronicen con Jobnet. Requiere integración formal con STAR (`spoc@star.dk`).
- **Recomendación:** si eres un job board o ATS legítimo, ve por la vía partnership. Si no, scraping de listings individuales para research es zona gris.

### The Hub / thehub.io (Nordic startups)

- **Estado:** **API JSON interna pública** (varios scrapers documentados la usan). Sin auth.
- **Riesgo legal:** **bajo**. Datos públicos, sin PII (los founders aparecen por nombre + LinkedIn link público, ojo si almacenas eso).
- **Scrapers:**
  - Apify `peaceful_pushpins/thehub-startups-scraper` (startups)
  - Apify `unfenced-group/thehub-io-scraper` (jobs, $2.49/1k)
  - Apify `alaricus/the-hub-io-scraper` (startups + investors, 10k+ records)
- **Cobertura:** 10k+ startups nórdicos (DK, SE, NO, FI, IS).
- **Recomendación:** el más fácil del lote Nordic. Ideal para lead gen de startups, due diligence, VC research.

### LinkedIn (perfiles públicos)

- **Estado:** scraping **legal en US** post *hiQ* (CFAA no aplica a datos públicos sin auth).
- **Riesgo legal:** **alto en práctica**:
  - *hiQ perdió en ToS* — el contrato que aceptas al registrarte prohíbe scraping. Aunque no es crime, es breach of contract.
  - LinkedIn ha demandado a **múltiples** scrapers (hiQ, Antropic, etc.) y gana acuerdos extrajudiciales.
  - En EU, GDPR aplica si scraped PII de residentes UE. Necesitas base legal (legitimate interest + LIA + opt-out funcional + data minimization).
- **Riesgo técnico:** aggressive bot detection (CAPTCHA, IP bans, account bans).
- **Recomendación:** **ok para research personal o análisis de mercado limitado**, **no para construir un producto comercial**. Si lo haces, opera desde EU, documenta LIA, respeta opt-outs, no re-vendas data.

### Xing (perfiles públicos, DACH)

- **Estado:** scraping técnicamente posible sin auth.
- **Riesgo legal:** **bajo-medio**. Similar a LinkedIn pero Xing no litiga tan agresivamente.
- **Truco:** Google X-ray funciona — `site:xing.com inurl:profile intext:"..."` indexa perfiles públicos.
- **Recomendación:** viable para sourcing DACH. Complemento perfecto a LinkedIn para DACH.

### Wellfound (startups)

- **Estado:** scraping **difícil**. DataDome anti-bot, requiere CSRF token + sesión verificada + proxy residencial.
- **Riesgo legal:** medio (T+C prohíbe, sin jurisprudencia clara).
- **Alternativa comercial:** Apify `skootle/wellfound-jobs-scraper` ($0.079/job).
- **Recomendación:** solo si tu producto vive de datos de startups. Vale la pena el coste.

### StepStone (DACH)

- **Estado:** scraping viable con throttle.
- **Riesgo legal:** **bajo**. Sin jurisprudencia adversa, T&C restrictivos pero sin litigios conocidos.
- **Alternativa comercial:** Scrappa, Parse.bot, Apify.
- **Recomendación:** viable para market research, no para reventa.

### Welcome to the Jungle (UK/FR/DE)

- **Estado:** scraping viable, sin auth.
- **Riesgo legal:** bajo.
- **Recomendación:** ideal para datos de empresa (cultura, beneficios, equipo). Sin protección anti-bot fuerte.

### Kununu (DACH)

- **Estado:** scraping funcional, sin auth para overview. Reviews completas detrás de login.
- **Riesgo legal:** medio (PII si guardas nombres de empleados).
- **Recomendación:** útil para employer branding research, no para reventa.

### Indeed (listings)

- **Estado:** scraping **bloqueado agresivamente**. IP bans, CAPTCHA, account bans.
- **Riesgo legal:** **alto**. Indeed litiga y su ToS es explícito.
- **Alternativas comerciales:** JobsPipe, Apify, Bright Data, Oxylabs.
- **Recomendación:** evita scraping directo. Usa agregador o partner program.

### Glassdoor (reviews)

- **Estado:** scraping viable con sesión autenticada (login wall).
- **Riesgo legal:** **alto**. T+C prohíbe, ToS enforces, y la mayoría de reviews completos son PII de empleados nombrados.
- **Recomendación:** si scraped, **solo datos agregados y públicos** (rating promedio, salary bands). Nunca PII de reviewers.

---

## Tier D — Prohibidas o de altísimo riesgo

- **Indeed / Glassdoor scraping comercial** → litigios activos, ToS estricto, IP bans
- **EURES sin ser partner** → T&C prohíbe explícitamente "screen scraping" en europa.eu/eures/portal
- **LinkedIn a escala comercial** → demandado en múltiples ocasiones (hiQ, Anthropic data case, otros)
- **Wellfound a escala** → DataDome + ToS
- **Cualquier portal detrás de login con datos de求职者** → riesgo GDPR grave
- **Stack Overflow / Reddit / sitios con T&C prohibitiva + login** → no vale la pena
- **Sitios con DMCA §1201 + bypass de CAPTCHAs** → riesgo penal

---

## Marco legal 2026 (US + EU)

### Estados Unidos — CFAA y casos clave

**hiQ Labs v. LinkedIn (9th Cir. 2022)**
- Sentencia: scraping de datos **públicos sin auth** no viola el Computer Fraud and Abuse Act (CFAA).
- "Without authorization" del CFAA se aplica a sistemas con auth, no a páginas públicas.
- *Pero* hiQ perdió en breach of contract (aceptó User Agreement al registrarse → ese contrato prohíbe scraping y es ejecutable).

**Meta v. Bright Data (N.D. Cal., ene 2024)**
- Summary judgment: los ToS de Meta **no rigen** scraping de datos públicos por usuarios no autenticados.
- Refuerza hiQ y da luz verde más clara al scraping de páginas públicas.

**Reddit v. Perplexity (2024–2025)**
- Caso en curso. Allegaciones de circumvention técnica (DMCA §1201) por evitar rate limits.
- Señal: si bypaseas anti-bot, entras en zona de riesgo DMCA aunque los datos sean públicos.

**Van Buren (2021)**
- "Without authorization" requiereجاوز auth wall real, no basta con violar ToS.

### Unión Europea — GDPR, TDM, AI Act

**GDPR (Reglamento 2016/679)**
- Aplica a PII de residentes UE **donde sea que operes**.
- "PII" incluye nombre, email, foto, identificador online (URL de perfil), IP, etc.
- Base legal para scraping: **legitimate interest (Art. 6(1)(f))** + LIA (Legitimate Interest Assessment) documentado.
- Obligaciones: opt-out funcional, honor de right to erasure en 30 días, data minimization, retention policy, no transferencia a países sin adequacy decision sin safeguards (SCCs/BCRs).
- **Aunque los datos sean "públicos", GDPR aplica.**

**TDM Exception (Art. 4 DSM Directive 2019/790)**
- Text and Data Mining para investigación científica: excepción automática.
- TDM comercial: requiere opt-out del titular (robots.txt, T&C explícito, headers HTTP).

**AI Act (Reglamento 2024/1689, entrada en vigor progresiva hasta 2027)**
- Categoría "high-risk" incluye **empleo y recruitment** (Anexo III).
- Si scraped data alimenta modelos que toman decisiones de hiring (filtrado de CVs, scoring, screening), hay obligaciones de transparencia, data quality, human oversight, conformity assessment.
- Prohibido uso de datos de候选人 para emotion recognition, social scoring, etc.

**National implementations (2024–2026)**
- Alemania: Bundesgerichtshof ha confirmado scraping público como legal bajo condiciones.
- Francia: CNIL ha multado por scraping agresivo de PII.
- Italia: GPDP activo.
- España: AEPD ha emitido guidance sobre scraping y bases jurídicas.

### Reino Unido — DPA 2018 + CMA

- Aplica post-Brexit, alineado con GDPR en espíritu.
- ICO ha procesado casos de scraping agresivo de PII.

### Tests rápidos para evaluar viabilidad

1. **¿Los datos son públicos sin login?** → sí → legal en US (CFAA) / UE (TDM research)
2. **¿Hay bypass de CAPTCHA o rate limits?** → sí → DMCA §1201 risk, ilegal
3. **¿Hay PII de residentes UE?** → sí → GDPR aplica, necesitas base legal + LIA
4. **¿Hay Creative Commons / copyright?** → sí → respetar licencia
5. **¿El ToS del sitio prohíbe scraping?** → sí → contract risk (no penal, pero litigable)
6. **¿Re-vendes los datos?** → sí → mayor scrutiny en todos los ejes
7. **¿Los datos alimentan decisiones de hiring automatizadas?** → sí → AI Act "high-risk"

---

## Snippets de código listos para usar

### Stack gratuito y legal con normalización

```python
"""
job_aggregator.py — Agrega ofertas de 5 fuentes públicas gratuitas.
Salida: JSON normalizado con campos {title, company, location, remote, url, source, posted_at}.
"""

import asyncio
import aiohttp
import json
from datetime import datetime
from typing import AsyncIterator

NORMALIZED_SCHEMA = {
    "title": str,
    "company": str,
    "location": str,
    "remote": bool,
    "url": str,
    "source": str,
    "posted_at": str,
    "salary_min": (int, type(None)),
    "salary_max": (int, type(None)),
    "currency": (str, type(None)),
    "tags": list,
}

async def fetch_arbeitnow(session, keyword=None) -> list[dict]:
    """Arbeitnow: Europe/remote, sin auth, visa_sponsorship flag."""
    url = "https://arbeitnow.com/api/job-board-api"
    params = {}
    if keyword:
        params["search"] = keyword
    async with session.get(url, params=params) as r:
        data = await r.json()
        return [
            {
                "title": j["title"],
                "company": j["company_name"],
                "location": j.get("location", ""),
                "remote": j.get("remote", False),
                "url": j["url"],
                "source": "arbeitnow",
                "posted_at": datetime.fromtimestamp(j["created_at"]).isoformat(),
                "salary_min": None,
                "salary_max": None,
                "currency": None,
                "tags": j.get("tags", []),
            }
            for j in data.get("data", [])
        ]

async def fetch_remoteok(session) -> list[dict]:
    """RemoteOK: solo remote, JSON directo, CORS abierto."""
    url = "https://remoteok.com/api"
    headers = {"User-Agent": "Mozilla/5.0 (compatible; job-aggregator/1.0)"}
    async with session.get(url, headers=headers) as r:
        data = await r.json()
        # El primer elemento es metadata legal
        jobs = data[1:] if len(data) > 1 else []
        return [
            {
                "title": j.get("position", ""),
                "company": j.get("company", ""),
                "location": "Remote",
                "remote": True,
                "url": j.get("url", ""),
                "source": "remoteok",
                "posted_at": j.get("date", ""),
                "salary_min": j.get("salary_min"),
                "salary_max": j.get("salary_max"),
                "currency": None,
                "tags": j.get("tags", []),
            }
            for j in jobs
        ]

async def fetch_remotive(session, category=None) -> list[dict]:
    """Remotive: curado, categories disponibles."""
    url = "https://remotive.com/api/remote-jobs"
    params = {}
    if category:
        params["category"] = category
    async with session.get(url, params=params) as r:
        data = await r.json()
        return [
            {
                "title": j["title"],
                "company": j["company_name"],
                "location": j.get("candidate_required_location", "Remote"),
                "remote": True,
                "url": j["url"],
                "source": "remotive",
                "posted_at": j["publication_date"],
                "salary_min": None,
                "salary_max": None,
                "currency": None,
                "tags": [j["category"]] + j.get("tags", []),
            }
            for j in data.get("jobs", [])
        ]

async def fetch_adzuna(session, app_id, app_key, country="gb", keyword=None, where=None) -> list[dict]:
    """Adzuna: 16+ países, salario estructurado, 1k calls/mes gratis."""
    url = f"https://api.adzuna.com/v1/api/jobs/{country}/search/1"
    params = {
        "app_id": app_id,
        "app_key": app_key,
        "results_per_page": 50,
        "content-type": "application/json",
    }
    if keyword:
        params["what"] = keyword
    if where:
        params["where"] = where
    async with session.get(url, params=params) as r:
        data = await r.json()
        return [
            {
                "title": j["title"],
                "company": j["company"]["display_name"],
                "location": j["location"]["display_name"],
                "remote": j.get("contract_type", "") == "remote",
                "url": j["redirect_url"],
                "source": "adzuna",
                "posted_at": j["created"],
                "salary_min": j.get("salary_min"),
                "salary_max": j.get("salary_max"),
                "currency": "GBP" if country == "gb" else None,
                "tags": [j.get("category", {}).get("label", "")],
            }
            for j in data.get("results", [])
        ]

async def fetch_infojobs(session, client_id, client_secret, keyword=None, province=None) -> list[dict]:
    """InfoJobs: España completa, Basic Auth."""
    url = "https://api.infojobs.net/api/9/offer"
    params = {"maxResults": 50}
    if keyword:
        params["keyword"] = keyword
    if province:
        params["province"] = province
    auth = aiohttp.BasicAuth(client_id, client_secret)
    async with session.get(url, params=params, auth=auth) as r:
        data = await r.json()
        return [
            {
                "title": j["title"],
                "company": j["author"]["name"],
                "location": j["city"],
                "remote": "teletrabajo" in j.get("workday", []),
                "url": j["link"],
                "source": "infojobs",
                "posted_at": j["published"],
                "salary_min": None,
                "salary_max": None,
                "currency": None,
                "tags": [j.get("category", "")],
            }
            for j in data.get("offers", [])
        ]

async def aggregate(app_id=None, app_key=None, ij_id=None, ij_secret=None, keyword=None):
    """Lanza todas las queries en paralelo y deduplica por URL."""
    async with aiohttp.ClientSession() as session:
        tasks = [
            fetch_arbeitnow(session, keyword),
            fetch_remoteok(session),
            fetch_remotive(session),
        ]
        if app_id and app_key:
            tasks.append(fetch_adzuna(session, app_id, app_key, keyword=keyword))
        if ij_id and ij_secret:
            tasks.append(fetch_infojobs(session, ij_id, ij_secret, keyword=keyword))

        results = await asyncio.gather(*tasks, return_exceptions=True)

    flat = []
    for batch in results:
        if isinstance(batch, list):
            flat.extend(batch)
        else:
            print(f"Error: {batch}")

    # Dedup por URL
    seen = set()
    unique = []
    for job in flat:
        if job["url"] not in seen:
            seen.add(job["url"])
            unique.append(job)

    return unique

# Ejemplo de uso:
# jobs = asyncio.run(aggregate(
#     app_id=os.environ["ADZUNA_ID"],
#     app_key=os.environ["ADZUNA_KEY"],
#     ij_id=os.environ["INFOJOBS_ID"],
#     ij_secret=os.environ["INFOJOBS_SECRET"],
#     keyword="python developer",
# ))
# print(f"{len(jobs)} ofertas únicas")
```

### Scraping responsable de Jobindex (cuando no haya alternativa)

```python
"""
jobindex_scraper.py — Scraper con respeto a robots.txt, throttle, y minimización.
Solo para investigación y agregación propia. Cumple GDPR (no PII, no contacto求职者).
"""

import asyncio
import aiohttp
from urllib.parse import urljoin
from urllib.robotparser import RobotFileParser
from bs4 import BeautifulSoup
from datetime import datetime

BASE_URL = "https://www.jobindex.dk"
ROBOTS_URL = f"{BASE_URL}/robots.txt"
USER_AGENT = "JobResearchBot/1.0 (research@example.com)"
RATE_LIMIT_SECONDS = 2.0  # 1 req / 2s = 30 req/min, conservador

async def check_robots(session) -> RobotFileParser:
    rp = RobotFileParser()
    async with session.get(ROBOTS_URL) as r:
        rp.parse((await r.text()).splitlines())
    return rp

async def fetch_with_throttle(session, url, robots):
    """Solo descarga si robots.txt lo permite y con delay."""
    if not robots.can_fetch(USER_AGENT, url):
        raise PermissionError(f"robots.txt bloquea {url}")
    await asyncio.sleep(RATE_LIMIT_SECONDS)
    async with session.get(url, headers={"User-Agent": USER_AGENT}) as r:
        return await r.text()

async def scrape_jobindex_listing(session, search_url, robots, max_pages=5):
    """Scrape listings, NO PII de求职者, solo datos de la oferta."""
    html = await fetch_with_throttle(session, search_url, robots)
    soup = BeautifulSoup(html, "html.parser")

    jobs = []
    for job_card in soup.select("div.jobsearch-result"):
        title_el = job_card.select_one("h4 a")
        if not title_el:
            continue
        title = title_el.get_text(strip=True)
        url = urljoin(BASE_URL, title_el["href"])
        company = job_card.select_one(".company-name")
        location = job_card.select_one(".location")
        date_posted = job_card.select_one(".date-posted")

        jobs.append({
            "title": title,
            "company": company.get_text(strip=True) if company else None,
            "location": location.get_text(strip=True) if location else None,
            "url": url,
            "date_posted": date_posted.get("datetime") if date_posted else None,
            "source": "jobindex",
            "scraped_at": datetime.utcnow().isoformat(),
        })

    return jobs

# IMPORTANTE: este código es ejemplo. Antes de producción:
# 1. Revisa robots.txt específico de la sección que scrapeas.
# 2. Identifícate con User-Agent real y contacto en caso de queja.
# 3. Implementa retry con backoff exponencial.
# 4. No hagas storage permanente si scraped PII (que no deberías).
# 5. Respeta opt-outs: si un求职者 pide borrar su data, hazlo en 30 días.
# 6. Si el sitio lo permite, contacta con su partnership program antes de scrapear.
```

---

## Recomendación final — Stack mínimo viable

### Opción A — 100% legal y gratis (cubre ~80% Europa)

| Componente | Cobertura | Coste |
|---|---|---|
| Adzuna API | UK, FR, DE, ES, IT, NL, AT, BE, PL, US, AU, NZ, IN, CA, CH, SG | Gratis hasta 1k calls/mes |
| InfoJobs API | España completa | Gratis con registro |
| Arbeitnow API | Europa + remote | Gratis, sin auth |
| RemoteOK API | Remote global | Gratis, sin auth |
| Remotive API | Remote curado | Gratis, sin auth |
| France Travail API | Francia completa | Gratis con registro OAuth2 |
| GitHub REST | Developers | Gratis, 5k/hr |

**Pros:** sin litigios, sin ToS, sin GDPR issues para listings (no son PII).
**Contras:** sin Glassdoor, sin LinkedIn, sin StepStone, sin Wellfound.

### Opción B — Tier A + scraping responsable

Añadir:
- The Hub scraping (startups Nordic) — bajo riesgo
- Jobindex scraping (DK) — bajo riesgo para listings
- Xing X-ray via Google (DACH) — bajo riesgo
- StepStone vía agregador (Scrappa/Parse.bot/Apify) — bajo riesgo, ~$0.20/1k

### Opción C — Tier A + Tier C comercial

Añadir agregadores de pago:
- JobsPipe — Indeed + Glassdoor + 30 ATS normalizados
- Apify Store — múltiples scrapers por fuente
- Bright Data / Oxylabs — infraestructura de scraping
- Techmap — EURES + 60k fuentes
- Parse.bot — StepStone, WTTJ, InfoJobs, etc.

### Opción D — Partnership program

Si eres un job board, ATS, o HR tech con usuarios reales:
- LinkedIn Talent Solutions
- Indeed Apply partner
- Jobnet JobannonceService (STAR)
- Xing E-Recruiting
- EURES (vía NCO)

---

## Directorio completo de plataformas (referencia rápida)

### Redes profesionales (tipo LinkedIn)

| Plataforma | Idioma/Región | Miembros / scale | Estado API | Riesgo scraping |
|---|---|---|---|---|
| LinkedIn | Global | 1B+ | Restringida (3 scopes) | Alto |
| Xing | DE/AT/CH | 22M | Solo E-Recruiting | Bajo |
| Viadeo | FR | 40M (declive) | Muerta | N/A |
| Wellfound | Global EN | 10M | Muerta | Difícil (DataDome) |
| Welcome to the Jungle | UK/FR/DE | ~1M | Muerta | Bajo |
| GitHub | Global | 100M+ | Excelente REST | N/A |
| Stack Overflow | Global | 100M+ | Cerrado (Jobs murió 2022) | Bajo |
| Behance | Global | 50M+ | Cerrada a público | Medio |
| Dribbble | Global | 10M+ | Cerrada a público | Medio |
| Meetup | Global | 50M+ | Cerrada a público | Bajo |
| Lunchclub | Global EN | 1M+ | Cerrada a público | Bajo |
| X (Twitter) | Global | 500M+ | API de pago desde 2023 | Alto |
| Connecting Odds | Global EN | Cohorte 2026 | Sin info | N/A |

### Job boards globales / pan-europeos

| Plataforma | Cobertura | API | Scraping |
|---|---|---|---|
| LinkedIn Jobs | Global | Restringida | Alto riesgo |
| Indeed | 28 países UE | Muerta (2021) | Alto (bot protection) |
| Glassdoor | 15 países UE | Muerta (2023) | Alto (login wall) |
| EURES | 27 UE + EFTA | Solo partners | Prohibido en T&C |
| Adzuna | 16+ países | ✅ Gratis 1k/mes | N/A |
| EuroJobs.com | Pan-EU | Cerrada | Bajo |
| Welcome to the Jungle | UK/FR/DE | Muerta | Bajo |
| Honeypot.io | NL/DE | Cerrada | Bajo |
| Arbeitnow | EU/remote | ✅ Gratis total | N/A |
| RemoteOK | Global remote | ✅ Gratis total | N/A |
| Remotive | Global remote | ✅ Gratis total | N/A |
| Jobicy | Global remote | ✅ Gratis total | N/A |
| Himalayas | Global remote | ✅ Gratis total | N/A |

### España

| Plataforma | Cobertura | API | Scraping |
|---|---|---|---|
| InfoJobs | Nacional, 40k+/día | ✅ Gratis con registro | N/A |
| Infoempleo | Nacional | Cerrada | Bajo |
| Tecnoempleo | Tech | Cerrada | Bajo |
| LinkedIn España | Tech/profesional | Restringida | Alto |
| Domestika | Creativos | Cerrada | Bajo |

### Alemania / DACH

| Plataforma | Cobertura | API | Scraping |
|---|---|---|---|
| StepStone | DACH 500k+ | Muerta | Bajo |
| Xing | DE/AT/CH 22M | Solo E-Recruiting | Bajo |
| Monster.de | DE | Cerrada | Bajo |
| Arbeitsagentur | DE oficial | ✅ Gratis OAuth2 | N/A |
| Berlin Startup Jobs | Berlin | Cerrada | Bajo |
| Arbeitnow | DE + EU + remote | ✅ Gratis total | N/A |
| Joblift | DE aggregator | Cerrada | Bajo |
| Stellenanzeigen.de | DE | Cerrada | Bajo |
| it-jobs.de | DE IT | Cerrada | Bajo |
| Jobvector | DE science | Cerrada | Bajo |
| Kununu | DACH reviews | Cerrada | Medio |

### UK

| Plataforma | Cobertura | API | Scraping |
|---|---|---|---|
| Reed.co.uk | UK generalista | ✅ Pago | N/A |
| TotalJobs | UK | Cerrada | Bajo |
| CV-Library | UK | Cerrada | Bajo |
| CWJobs | UK tech | Cerrada | Bajo |
| Guardian Jobs | UK media | Cerrada | Bajo |
| Adzuna | UK fuerte | ✅ Gratis 1k/mes | N/A |

### Francia

| Plataforma | Cobertura | API | Scraping |
|---|---|---|---|
| France Travail (ex Pôle Emploi) | Nacional oficial | ✅ Gratis OAuth2 | N/A |
| APEC | Ejecutivos | Cerrada | Bajo |
| HelloWork (ex Regionsjob) | Regional/SME | Cerrada | Bajo |
| Cadremploi | Cuadros | Cerrada | Bajo |
| Station F board | Paris startups | Cerrada | Bajo |
| Welcome to the Jungle | France fuerte | Muerta | Bajo |

### Países Bajos

| Plataforma | Cobertura | API | Scraping |
|---|---|---|---|
| Nationale Vacaturebank | Nacional | Cerrada | Bajo |
| Magnet.me | Early career | Cerrada | Bajo |
| Intermediair.nl | Senior | Cerrada | Bajo |
| Indeed.nl | Global + NL | Muerta | Alto |
| Honeypot.io | Tech | Cerrada | Bajo |

### Bélgica / Suiza / Austria

| Plataforma | Cobertura | API | Scraping |
|---|---|---|---|
| StepStone BE/AT/CH | DACH+ | Muerta | Bajo |
| ICTjob.be | BE tech | Cerrada | Bajo |
| jobs.ch | CH | Cerrada | Bajo |
| karriere.at | AT | Cerrada | Bajo |

### Italia / Portugal / Polonia / República Checa

| Plataforma | Cobertura | API | Scraping |
|---|---|---|---|
| InfoJobs.it | IT | ✅ Igual que España | N/A |
| LinkedIn Italia | IT | Restringida | Alto |
| Net-Empregos | PT | Cerrada | Bajo |
| Sapo Emprego | PT | Cerrada | Bajo |
| Pracuj.pl | PL | Cerrada | Bajo |
| Jobs.cz | CZ | Cerrada | Bajo |

### Escandinavia

| Plataforma | Cobertura | API | Scraping |
|---|---|---|---|
| Jobindex.dk | DK 80% mercado | ❌ Sin API pública | Bajo |
| Jobnet.dk | DK oficial | JobannonceService B2B | Medio (T&C) |
| Workindenmark.dk | DK internacional | ❌ Sin API | Bajo |
| The Hub (thehub.io) | DK/SE/NO/FI/IS startups | JSON interno público | Bajo |
| it-jobbank.dk | DK IT | ❌ Sin API | Bajo |
| JobTech Dev | SE oficial | ✅ Gratis con key | N/A |
| Arbetsförmedlingen | SE oficial | Via JobTech | N/A |
| Blocket Jobb | SE | Cerrada | Bajo |
| Finn.no Jobb | NO | Cerrada | Bajo |
| NAV (NO) | NO oficial | Parcial vía JobTech | N/A |
| TE Services (FI) | FI oficial | Parcial | N/A |

### Reviews de empresa (tipo Glassdoor)

| Plataforma | Región | API | Scraping |
|---|---|---|---|
| Glassdoor | Global | Muerta 2023 | Alto (login) |
| Kununu | DACH | Cerrada | Medio |
| Indeed Company Pages | Global | Solo employer | Bajo |
| Comparably | US/UK | Cerrada | Medio |
| Blind | Global tech | Cerrada | Medio (anonimato) |
| Welcome to the Jungle | FR/UK | Muerta | Bajo |
| Fairygodboss | US/UK women | Cerrada | Bajo |
| Great Place to Work | Global | Certificación, no API | Bajo |
| InHerSight | US/UK diversity | Cerrada | Bajo |
| RepVue | US/UK sales | Cerrada | Bajo |

---

## Fuentes y referencias

### Documentación oficial de APIs
- Adzuna: https://developer.adzuna.com
- InfoJobs: https://developer.infojobs.net
- Arbeitnow: https://www.arbeitnow.com/blog/job-board-api
- RemoteOK: https://remoteok.com/api
- Remotive: https://remotive.com/api-documentation
- France Travail: https://www.francetravail.io
- Arbeitsagentur: https://www.arbeitsagentur.de
- JobTech Dev: https://jobtechdev.se
- GitHub REST: https://docs.github.com/en/rest
- LinkedIn: https://learn.microsoft.com/en-us/linkedin/
- Indeed: https://docs.indeed.com
- Xing: https://dev.xing.com

### Casos legales citados
- *hiQ Labs v. LinkedIn* (9th Cir. 2022): https://cdn.ca9.uscourts.gov/datastore/opinions/2022/04/18/17-16783.pdf
- *Meta v. Bright Data* (N.D. Cal. 2024): orden de summary judgment enero 2024
- *Van Buren v. United States* (2021)
- *Reddit v. Perplexity* (2024–2025, en curso)

### Regulaciones
- GDPR (UE 2016/679)
- AI Act (UE 2024/1689)
- DSM Directive (UE 2019/790, Art. 4 TDM)
- CFAA (US, 18 U.S.C. § 1030)
- DMCA §1201 (US)
- CCPA / CPRA (California)
- DPA 2018 (UK)

### Análisis de scraping 2026
- https://www.coronium.io/blog/is-web-scraping-legal-2026
- https://cloro.dev/blog/website-scraping-legal/
- https://dataresearchtools.com/web-scraping-legal-2026/
- https://nubela.co/blog/is-scraping-linkedin-legal-in-2026/
- https://www.leadsforlinked.com/blog/is-linkedin-scraping-legal.html
- https://www.leadsforlinked.com/blog/is-linkedin-scraping-gdpr-compliant

### Análisis de APIs cerradas
- https://clura.ai/blog/indeed-api
- https://clura.ai/blog/glassdoor-api
- https://jobspipe.dev/sources/indeed
- https://jobspipe.dev/sources/glassdoor
- https://www.socialcrawl.dev/blog/linkedin-data-api-2026
- https://connectsafely.ai/articles/linkedin-api-complete-guide-2026
- https://www.blotato.com/blog/linkedin-api-pricing
- https://www.outx.ai/blog/linkedin-api-guide
- https://www.getphyllo.com/post/linkedin-api-ultimate-guide-on-linkedin-api-integration

### Proveedores / agregadores
- Apify: https://apify.com
- Bright Data: https://brightdata.com
- JobsPipe: https://jobspipe.dev
- Parse.bot: https://parse.bot
- Scrappa: https://scrappa.co
- Techmap: https://jobdatafeeds.com
- Oxylabs: https://oxylabs.io
- ScrapingBee: https://scrapingbee.com
- Thirdwatch: https://thirdwatch.dev

### Directorios de APIs públicas
- https://publicapis.io
- https://github.com/public-apis/public-apis
- https://openpublicapis.com
- https://www.publicapilist.com
- https://www.opensourcestartups.com/apis

---

## Disclaimer

Este documento es **análisis técnico y de mercado**, no constituye consejo legal. Para deployments comerciales de scraping o construcción de productos con datos de求职者, consulta con abogado especializado en:
- Propiedad intelectual y ToS enforcement
- Protección de datos (GDPR, DPA UK, CCPA, LGPD, etc.)
- AI Act compliance si aplica a tu use case
- Derecho laboral si los datos alimentan decisiones de hiring

El panorama regulatorio y de APIs cambia **constantemente**. Verifica siempre el estado actual de cada API y T&C antes de integrar.

---

*Documento generado agosto 2026. Próxima revisión sugerida: febrero 2027.*
