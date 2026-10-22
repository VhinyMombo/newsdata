"""Chat model factory: one switch between the local Ollama model and hosted APIs.

LLM_PROVIDER picks the backend:
  ollama  (default) local model, OLLAMA_CHAT_MODEL
  gemini  Google AI Studio, OpenAI-compatible endpoint, GEMINI_API_KEY
  groq    Groq, OpenAI-compatible endpoint, GROQ_API_KEY

LLM_MODEL overrides the provider's default model. LLM_FALLBACK_PROVIDER
(with LLM_FALLBACK_MODEL) names a second backend tried when the first one
fails, typically a free-tier quota running out. LLM_BATCH_PROVIDER (with
LLM_BATCH_MODEL) moves the pipeline's bulk calls, a couple of hundred map
clusters to name per run, onto another backend, usually the local model, so
they don't burn the free quota the assistant needs. Embeddings are not
covered here: they stay on Ollama (embeddinggemma) whatever the provider,
because the stored vectors were built with it.
"""

import os

PROVIDER = os.getenv("LLM_PROVIDER", "ollama").lower()

_HOSTED = {
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai/", "GEMINI_API_KEY", "gemini-3.8-flash"),
    "groq": ("https://api.groq.com/openai/v1", "GROQ_API_KEY", "qwen/qwen3-32b"),
}

# Reasoning models (Qwen3, DeepSeek-R1…) think in hidden tokens before answering,
# which multiplies generation time — off by default, RAG synthesis rarely needs it.
REASONING_MODEL_PREFIXES = ("qwen3", "deepseek-r1", "magistral", "gpt-oss")
REASONING_ENABLED = os.getenv("OLLAMA_REASONING", "false").lower() == "true"


def _model_for(provider: str, override: str | None) -> str:
    if provider == "ollama":
        return override or os.getenv("OLLAMA_CHAT_MODEL", "qwen3.5:9b")
    if provider in _HOSTED:
        return override or _HOSTED[provider][2]
    raise ValueError(f"LLM_PROVIDER inconnu : {provider!r} (ollama, gemini ou groq)")


MODEL = _model_for(PROVIDER, os.getenv("LLM_MODEL"))
FALLBACK_PROVIDER = os.getenv("LLM_FALLBACK_PROVIDER", "").lower() or None
FALLBACK_MODEL = (_model_for(FALLBACK_PROVIDER, os.getenv("LLM_FALLBACK_MODEL"))
                  if FALLBACK_PROVIDER else None)
BATCH_PROVIDER = os.getenv("LLM_BATCH_PROVIDER", "").lower() or None
BATCH_MODEL = _model_for(BATCH_PROVIDER, os.getenv("LLM_BATCH_MODEL")) if BATCH_PROVIDER else None


def chat_model(temperature: float, num_ctx: int | None = None, max_tokens: int | None = None,
               batch: bool = False):
    """A LangChain chat model for the configured provider, with its fallback if any.

    batch=True is for the pipeline's bulk jobs: LLM_BATCH_PROVIDER when set.
    """
    if batch and BATCH_PROVIDER:
        return _build(BATCH_PROVIDER, BATCH_MODEL, temperature, num_ctx, max_tokens)
    primary = _build(PROVIDER, MODEL, temperature, num_ctx, max_tokens)
    if not FALLBACK_PROVIDER:
        return primary
    return primary.with_fallbacks(
        [_build(FALLBACK_PROVIDER, FALLBACK_MODEL, temperature, num_ctx, max_tokens)])


def _build(provider, model, temperature, num_ctx, max_tokens):
    if provider == "ollama":
        from langchain_ollama.chat_models import ChatOllama
        return ChatOllama(
            model=model,
            temperature=temperature,
            **({"num_ctx": num_ctx} if num_ctx else {}),
            **({"num_predict": max_tokens} if max_tokens else {}),
            **({"reasoning": REASONING_ENABLED}
               if model.lower().startswith(REASONING_MODEL_PREFIXES) else {}),
        )

    from langchain_openai import ChatOpenAI
    base_url, key_var, _ = _HOSTED[provider]
    api_key = os.getenv(key_var)
    if not api_key:
        raise RuntimeError(f"Le fournisseur {provider} demande la variable {key_var}")
    # "none" turns Gemini 2.5 Flash's and Qwen3's thinking off; leave it unset
    # for models that reject the parameter (Llama on Groq)
    effort = os.getenv("LLM_REASONING_EFFORT" if provider == PROVIDER else "LLM_FALLBACK_REASONING_EFFORT")
    return ChatOpenAI(
        model=model,
        base_url=base_url,
        api_key=api_key,
        temperature=temperature,
        max_retries=0 if FALLBACK_PROVIDER and provider == PROVIDER else 2,
        timeout=120,
        **({"max_tokens": max_tokens} if max_tokens else {}),
        **({"reasoning_effort": effort} if effort else {}),
    )
