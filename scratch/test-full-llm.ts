import { getLlmProvider } from '../src/lib/llm/provider';
import { toolSchemas } from '../src/lib/tools/registry';

async function testFullLlm() {
  const llm = getLlmProvider();
  console.log('Using provider model:', llm.model);
  const start = Date.now();
  const res = await llm.complete(
    [
      { role: 'system', content: 'You are a voice-first cooking assistant.' },
      { role: 'user', content: "Let's start making chicken gravy in the Indian way." },
    ],
    toolSchemas(),
    new AbortController().signal,
  );
  const ms = Date.now() - start;
  console.log(`LLM completed in ${ms}ms:`);
  console.log('Content:', res.content);
  console.log('Tool calls:', res.toolCalls);
}

testFullLlm();
