import { llmEnv } from '../src/lib/env';

async function listModels() {
  const env = llmEnv();
  const res = await fetch(`${env.baseUrl.replace(/\/$/, '')}/models`, {
    headers: { Authorization: `Bearer ${env.apiKey}` },
  });
  const data = await res.json();
  const textModels = data.data.filter((m: any) => m.output_modalities?.includes('text')).map((m: any) => ({
    id: m.id,
    name: m.name,
    tools: m.supported_features?.includes('tools') ?? false,
  }));
  console.log('Text models with tool support:', JSON.stringify(textModels, null, 2));
}

listModels();
