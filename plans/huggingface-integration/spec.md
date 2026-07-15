# Feature: Hugging Face Integration

## Why (short)

Hugging Face es **el** hub de AI/ML. Crece exponencialmente. Sus perfiles públicos muestran models, datasets, spaces — señal única de "AI practitioner activo". Si tu usuario busca "LLM fine-tuning" o "vector databases", HF es donde están los builders.

## API summary

- **Base URL**: `https://huggingface.co/api/`
- **Auth**: opcional, mejora rate limit
- **Endpoints**:
  - `GET /api/models?search={query}&limit=20` — search models
  - `GET /api/datasets?search={query}&limit=20`
  - `GET /api/users/{username}` — user profile (models, datasets, spaces, followers)
  - `GET /api/users?search={query}` — user search (limited)
- **Rate limit**: ~1000 req/h sin auth
- **Docs**: https://huggingface.co/docs/api

## Why honorable mention

- **Nicho vertical**: solo AI/ML
- **API limitado** para user search (no robusto)
- **Datos únicos**: model downloads, likes, datasets
- **No es "devs general"**: es "AI devs"

## Effort

**M (2-3 días)**. API no tan pulida, hay que escribir lógica custom para user discovery.

## Recommendation

**Integrate después de las 4 top picks**, si el vertical AI/ML es relevante para los usuarios. Si vemos queries tipo "transformers", "fine-tuning", "embeddings" sin buenos matches, este es el próximo paso.
