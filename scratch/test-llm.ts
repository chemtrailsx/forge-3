import { geminiEnv, groqEnv, llmEnv } from '../src/lib/env';

async function testProvider(name: string, env: any) {
  if (!env || !env.apiKey) {
    console.log(`${name}: not configured`);
    return;
  }
  console.log(`${name}: baseUrl=${env.baseUrl}, model=${env.model}`);
  try {
    const res = await fetch(`${env.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.model,
        messages: [{ role: 'user', content: 'Say hi in one word' }],
        max_tokens: 10,
      }),
    });
    console.log(`${name} status:`, res.status);
    const text = await res.text();
    console.log(`${name} response:`, text.slice(0, 300));
  } catch (err: any) {
    console.log(`${name} error:`, err.message);
  }
}

async function main() {
  console.log('Testing configured LLMs:');
  await testProvider('Default LLM', llmEnv());
  await testProvider('Gemini LLM', geminiEnv());
  await testProvider('Groq LLM', groqEnv());
}

main();
