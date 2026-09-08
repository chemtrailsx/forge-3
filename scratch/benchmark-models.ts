import { llmEnv } from '../src/lib/env';

async function testModel(modelId: string) {
  const env = llmEnv();
  const start = Date.now();
  const res = await fetch(`${env.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
      max_tokens: 50,
    }),
  });
  const ms = Date.now() - start;
  console.log(`${modelId}: status ${res.status} in ${ms}ms`);
  const data = await res.json();
  console.log('Result:', data.choices?.[0]?.message?.content);
}

async function main() {
  await testModel('openai/gpt-oss-20b');
  await testModel('qwen/qwen3.6-27b');
  await testModel('openai/gpt-oss-120b');
}

main();
