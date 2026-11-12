import OpenAI from 'openai';

export interface ModelSpec {
  provider: 'openai' | 'deepinfra';
  model: string;
  // USD per 1M tokens
  priceIn: number;
  priceCachedIn: number;
  priceOut: number;
}

// Prices as published by the provider (USD / 1M tokens). Override with BENCH_PRICE_IN/_CACHED/_OUT.
const PRICES: Record<string, [number, number, number]> = {
  'gpt-4.1-mini': [0.4, 0.1, 1.6],
  'gpt-4.1': [2.0, 0.5, 8.0],
  'gpt-4.1-nano': [0.1, 0.025, 0.4],
  'gpt-4o-mini': [0.15, 0.075, 0.6],
  'meta-llama/Llama-3.3-70B-Instruct-Turbo': [0.13, 0.13, 0.39],
  'Qwen/Qwen3-235B-A22B-Instruct-2507': [0.13, 0.13, 0.6],
  'deepseek-ai/DeepSeek-V3.1': [0.27, 0.27, 1.0],
};

export function modelSpec(provider: string, model: string): ModelSpec {
  const p = PRICES[model];
  const env = (k: string) => (process.env[k] ? Number(process.env[k]) : undefined);
  const priceIn = env('BENCH_PRICE_IN') ?? p?.[0];
  const priceOut = env('BENCH_PRICE_OUT') ?? p?.[2];
  if (priceIn === undefined || priceOut === undefined) throw new Error(`no price for ${model}; set BENCH_PRICE_IN/BENCH_PRICE_OUT`);
  return { provider: provider as ModelSpec['provider'], model, priceIn, priceCachedIn: env('BENCH_PRICE_CACHED') ?? p?.[1] ?? priceIn, priceOut };
}

export function client(spec: ModelSpec): OpenAI {
  if (spec.provider === 'deepinfra') {
    const apiKey = process.env.DEEPINFRA_API_KEY;
    if (!apiKey) throw new Error('DEEPINFRA_API_KEY missing');
    return new OpenAI({ apiKey, baseURL: 'https://api.deepinfra.com/v1/openai', maxRetries: 4, timeout: 120_000 });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');
  return new OpenAI({ apiKey, maxRetries: 4, timeout: 120_000 });
}

export function cost(spec: ModelSpec, u: { prompt: number; cached: number; completion: number }): number {
  return ((u.prompt - u.cached) * spec.priceIn + u.cached * spec.priceCachedIn + u.completion * spec.priceOut) / 1e6;
}
