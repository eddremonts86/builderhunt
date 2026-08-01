-- Custom SQL migration file, put your code below! --
-- Seeds the capability vocabulary.
--
-- Third instance of the same root cause as 0127: the Phase 4 work was developed against rows inserted
-- ad hoc into one developer database, and `solution_capabilities` was empty on every fresh one. Since
-- `solution_component_capabilities.capability_key` is a foreign key into this table, the first real
-- ingestion run died on
-- `23503 ... Key (capability_key)=(embedding) is not present in table "solution_capabilities"`.
--
-- Nothing caught it because the failure is one layer past where the tests stop: the unit tests insert
-- the one capability their fixture needs, so the FK is satisfied for `translation` and never exercised
-- for the other ten keys the adapters can actually emit.
--
-- These keys must stay in step with `SOLUTION_CAPABILITIES` in src/shared/lib/solutions/contracts.ts,
-- which is now where the vocabulary is defined and which types every adapter's mapping table — so a
-- misspelled capability is a compile error rather than a foreign-key violation on the first run. A
-- parity test asserts the constant and these rows never drift apart.
--
-- Deliberately coarse. A vocabulary with a hundred near-synonyms cannot be matched against a brief: two
-- components claiming `translation` and `machine_translation` would look unrelated to the composer.

INSERT INTO "solution_capabilities" ("key", "label", "description") VALUES
  ('translation', 'Translation', 'Converts text from one natural language to another.'),
  ('summarization', 'Summarization', 'Produces a shorter version of a longer text.'),
  ('transcription', 'Transcription', 'Converts speech audio to text.'),
  ('text_generation', 'Text generation', 'Produces free-form text from a prompt.'),
  ('embedding', 'Embedding', 'Maps text or other content to vectors for similarity search.'),
  ('classification', 'Classification', 'Assigns content to one of a set of labels.'),
  ('entity_extraction', 'Entity extraction', 'Identifies named entities and spans within text.'),
  ('image_understanding', 'Image understanding', 'Derives text or structure from an image.'),
  ('document_understanding', 'Document understanding', 'Extracts structure and answers from documents such as PDFs.'),
  ('web_extraction', 'Web extraction', 'Retrieves and structures content from web pages.'),
  ('data_transformation', 'Data transformation', 'Moves and reshapes data between formats or systems.')
ON CONFLICT ("key") DO UPDATE SET
  "label" = EXCLUDED."label",
  "description" = EXCLUDED."description";
