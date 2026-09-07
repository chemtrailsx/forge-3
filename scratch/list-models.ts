import { llmEnv } from '../src/lib/env';

async function listModels() {
  const env = llmEnv();
  const res = await fetch(`${env.baseUrl.replace(/\/$/, '')}/models`, {
    headers: { Authorization: `Bearer ${env.apiKey}` },
  });
  const data = await res.json();
  console.log('Available models:', JSON.stringify(data, null, 2));
}

listModels();
