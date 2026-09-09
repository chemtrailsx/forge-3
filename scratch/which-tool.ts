/**
 * Which tool does a given model reach for when someone says what they want to
 * cook? A model that answers without calling `plan_recipe` is the bug the cook
 * sees as "it refused to help with a recipe I have not saved".
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(resolve(process.cwd(), file), 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!(key in process.env)) process.env[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // Absent file is fine.
  }
}


const EMPTY_SESSION = {
  id: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  recipeId: null,
  currentStep: 0,
  status: 'active' as const,
  notes: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

async function main(): Promise<void> {
  const { buildMessages } = await import('../src/lib/llm/prompt');
  const { toolSchemas } = await import('../src/lib/tools/registry');
  const { OpenAiCompatibleProvider } = await import('../src/lib/llm/provider');
  const { llmEnv } = await import('../src/lib/env');
  const { buildSnapshot } = await import('../src/lib/cooking/state');

  async function ask(model: string, utterance: string) {
    const provider = new OpenAiCompatibleProvider({ ...llmEnv(), model, fallbackModel: model });
    const messages = buildMessages({
      state: buildSnapshot(EMPTY_SESSION, null, []),
      memory: [],
      preferences: {},
      history: [],
      utterance,
    });
    const result = await provider.complete(messages, toolSchemas(), AbortSignal.timeout(60000));
    const called = result.toolCalls.map((c) => c.name);
    console.log(
      `${model.padEnd(22)} tools=[${called.join(', ') || 'NONE'}]  said="${result.content.slice(0, 150).replace(/\s+/g, ' ')}"`,
    );
  }

  const utterance = process.argv[3] ?? 'I want to make white sauce chicken pasta';
  const models = (process.argv[2] ?? 'openai/gpt-oss-120b,openai/gpt-oss-20b').split(',');
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await ask(model, utterance);
      } catch (error) {
        console.log(`${model.padEnd(22)} ERROR ${(error as Error).message.slice(0, 120)}`);
      }
    }
  }
}

void main();
