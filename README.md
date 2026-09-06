# Cooking Companion

A voice-first cooking assistant. **Don't stop cooking to use a screen — just talk.**

The assistant holds the cooking state (recipe, step, servings, substitutions, timers) and the
user's own history across sessions, answers hands-free, and — the part that actually matters —
handles being interrupted mid-sentence without losing track of what the cook heard.

Rime is the primary spoken-output layer. Everything else — auth, recognition, reasoning, memory,
tools, interruption handling — is this application's job.

---

## What it does

| Voice feature | Where it lives |
| --- | --- |
| **Backchanneling** — "mm-hm" during a long user turn | [`src/lib/voice/backchannel.ts`](src/lib/voice/backchannel.ts), [`src/app/api/backchannel/route.ts`](src/app/api/backchannel/route.ts) |
| **Barge-in + state recovery** — stop Rime, cancel the turn, keep only what was heard | [`src/lib/voice/voice-client.ts`](src/lib/voice/voice-client.ts), [`src/lib/voice/heard-ledger.ts`](src/lib/voice/heard-ledger.ts), [`src/lib/voice/orchestrator.ts`](src/lib/voice/orchestrator.ts) |
| **Voice fillers during tool calls** — speech instead of dead air | `runTools()` in [`src/lib/voice/orchestrator.ts`](src/lib/voice/orchestrator.ts); wording lives on each tool |
| **Dynamic speaking speed** — slower for measurements and timers | [`src/lib/tts/speech-profile.ts`](src/lib/tts/speech-profile.ts), [`src/lib/tts/speakable.ts`](src/lib/tts/speakable.ts) |
| **Persistent cooking context** — recipe, step, servings, subs, timers, corrections | [`src/lib/cooking/state.ts`](src/lib/cooking/state.ts) |

---

## Architecture

```
Browser                                   Server                        Providers
────────────────────────────────────────  ────────────────────────────  ─────────────
mic (always open, even while speaking)
  │
  ├─ mic-meter worklet ─→ VAD ────────────────────────────────────────────────────────
  │                        │
  │                        ├─ speech start while playing → BARGE-IN
  │                        │     stop player · abort fetch · compute heard text
  │                        │
  │                        └─ speech end → utterance blob
  │                                          │
  │                                          ▼
  │                                   POST /api/stt ─────────────→ Whisper (STT)
  │                                          │ transcript
  │                                          ▼
  │                                   POST /api/turn  (SSE, one cancellable request)
  │                                          │
  │                                    orchestrator
  │                                    ├─ cooking state (Postgres)
  │                                    ├─ relevant user memory
  │                                    ├─ conversation history (heard-only)
  │                                    ├─ LLM ──────────────────→ OpenAI-compatible
  │                                    ├─ tools (server-side, user-scoped)
  │                                    │    └─ filler while slow ─→ Rime (http)
  │                                    └─ answer → clauses → ────→ Rime (ws3)
  │                                          │
  └─ pcm-player worklet ←── audio + word timestamps + state events
```

Two design decisions carry most of the weight:

**Audio travels inside the turn's own SSE stream.** One request carries events *and* PCM, so a
barge-in is a single cancellation — aborting the fetch cancels Rime, the model and any in-flight
tool together. Two channels would leave one of them alive to talk over the correction.

**Rime `ws3` for streaming, HTTPS for rate changes.** `{"operation":"clear"}` cancels synthesis
Rime has accepted but not yet emitted, `contextId` makes "is this chunk stale?" an equality check
rather than a timing race, and word timestamps are what turn played samples into *which words were
heard*. But `timeScaleFactor` — the documented speed control for `coda` — is honoured on the HTTP
endpoint and ignored over the WebSocket, so the speech profiles that change rate use HTTP. The
adapter picks the transport; nothing above it knows.

### Layout

```
src/
  app/                    routes and pages (App Router)
    api/turn/             the conversational turn, as SSE
    api/stt/              speech to text
    api/backchannel/      short acknowledgements
    api/{recipes,sessions,memory,timers,health}/
    cook/[sessionId]/     the cooking screen
  components/             UI; cooking/ holds the voice console and its panels
  lib/
    audio/                browser: PCM player handle, VAD policy, recorder
    auth/session.ts       the only place identity enters the system
    cooking/              scaling, substitutions, cooking-state assembly
    db/                   repositories — every query scoped by user_id
    llm/                  OpenAI-compatible client + prompt construction
    memory/retrieval.ts   relevance selection for user memory
    stt/                  Whisper-compatible transcription
    tts/                  provider interface, speech profiles, speakable text
      rime/               the only Rime-aware code: ws3, http, adapter
    tools/                the nine backend tools + registry
    voice/                orchestrator, events, backchannel, heard ledger, client
supabase/migrations/      schema, indexes, RLS, new-user bootstrap
tests/                    vitest
public/worklets/          audio-thread code (PCM player, mic meter)
```

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Database

Create a free project at [supabase.com](https://supabase.com), then run both migrations, in order,
in the SQL editor (or with `psql "$DATABASE_URL" -f ...`):

```
supabase/migrations/0001_schema.sql
supabase/migrations/0002_rls.sql
```

`0002` enables and **forces** row-level security on every table, adds ownership triggers so a
crafted `recipe_id` cannot create a cross-user reference, and installs a trigger that gives each new
account a profile plus one starter recipe.

For local development, turn **off** email confirmation (Authentication → Providers → Email → uncheck
"Confirm email") so sign-up signs you straight in. Leave it on and sign-up returns "check your email
to confirm" — which works, via `/auth/callback`, but costs a round trip through your inbox on every
fresh account.

You can check which way a project is configured without opening the dashboard:

```bash
curl -s -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/settings" | grep -o '"mailer_autoconfirm":[a-z]*'
```

`true` means sign-up logs you straight in; `false` means confirmation is required.

### 3. Environment

```bash
cp .env.example .env.local
```

Every provider below has a free tier. Nothing here needs a card.

| Variable | Where to get it | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API | Safe in the browser *because* RLS is on |
| `SUPABASE_SERVICE_ROLE_KEY` | same page | Server only. Used by `npm run seed` and nothing else |
| `RIME_API_KEY` | [rime.ai](https://rime.ai) | Server only |
| `LLM_API_KEY` | [console.groq.com](https://console.groq.com) | Default model `openai/gpt-oss-120b` (free tier, supports tool calling) |
| `STT_API_KEY` | same Groq key works | Default model `whisper-large-v3-turbo` |

`LLM_BASE_URL` and `STT_ENDPOINT` default to Groq's OpenAI-compatible API. Point them anywhere
compatible — OpenAI, Together, a local Ollama — without touching code.

### 4. Check the wiring

```bash
npm run preflight
```

This validates the Rime model/voice pair against Rime's **live** voice catalog (not a doc page),
synthesises a real sentence, calls the model, and checks the STT endpoint and Supabase. It is the
fastest way to find a wrong key before a demo.

### 5. Run

```bash
npm run dev
```

Sign up, then **Start cooking** on the starter recipe.

Optional, for the personalisation half of the demo — a second recipe, a finished session and two
saved preferences:

```bash
npm run seed -- you@example.com
```

---

## Demo script

Set `TOOL_DELAY_MS=3000` in `.env.local` first, so the filler has a gap to cover.

1. **Resume** a session from the dashboard.
2. *"What am I doing now?"* — answered from state, no tool call.
3. Talk for five seconds or so about what you are making — a **backchannel** lands mid-turn.
4. *"Make it for six people."* — you hear *"Sure, let me recalculate that"* **before** the number
   exists, then the real answer. The ingredient panel updates.
5. *"Set a timer for eight minutes."* — the confirmation is spoken **slower**, with a pause before
   the number.
6. Ask for the next step, and **interrupt mid-sentence** with *"Wait, I haven't added the salt."*
   Audio stops, the interruption latency appears on screen, and the reply picks up from the
   correction rather than restarting the sentence you cut off.
7. *"How did I make this last time?"* — searches your own cooking history.
8. Open **Preferences & memory** to see, and delete, everything the assistant has stored.

---

## Security model

- **Identity comes from the session cookie, never from a request body.** `requireUser()` is the only
  place a user id is produced; every repository takes that id and no function accepts one from
  outside. A `user_id` sent by the browser is not used for authorization anywhere.
- **Two independent checks.** Every query filters on `user_id` *and* runs against forced RLS, so a
  mistake in either layer is not enough to leak a row. Both are tested — see
  `tests/data-isolation.test.ts`.
- **Secrets stay server-side.** Rime, LLM and STT keys are read only inside route handlers and
  scripts. The service-role key is behind a `server-only` import, so an accidental client import is
  a build error rather than a leak.
- **The model never sees another user's data.** Prompt construction reads from already-scoped
  queries; the memory selector sends only relevant rows, never the whole store.
- **Memory is inspectable and deletable** from the profile page, per row or all at once.
- **Missing configuration fails closed** — no Supabase means nobody is authenticated, and the login
  page says what to set.

---

## Testing

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run lint      # eslint
npm run build     # next build
```

99 tests across seven files. They run without network access or API keys: the orchestrator is an
async generator, so tests drive real turns with injected fake providers, and the database is an
in-memory PostgREST double that **also simulates RLS** — a test that forgets the application-level
filter still cannot read across users.

| File | Covers |
| --- | --- |
| `data-isolation.test.ts` | cross-user reads and writes; every query carries a `user_id` filter |
| `memory.test.ts` | relevance selection, avoidance priority, upsert-not-duplicate, deletion, heard-only history |
| `tools.test.ts` | all nine tools, argument validation, ownership, scaling maths, filler wording |
| `cooking-state.test.ts` | scaling and rounding, snapshots, timers, persistence across turns |
| `barge-in.test.ts` | ledger arithmetic, tracker cut points, no audio after abort, interrupted turn recorded and rewritten, slow tool cancelled |
| `voice-behaviour.test.ts` | speech-profile selection, speakable text, backchannel policy, VAD, filler timing |
| `orchestrator.test.ts` | turn shape, prompt contents, tool turns, tool-failure recovery, per-user separation |

---

## Known limitations

- **Echo cancellation is a hardware dependency.** The mic stays open while Rime speaks; on a device
  with poor AEC the assistant can hear itself and barge in on its own voice. Use a headset.
- **Backchannels are timing-based, not semantic.** The policy is deliberately conservative
  (3.5 s of speech, 9 s gap, two per turn) rather than trying to detect a natural pause.
- **No semantic memory retrieval yet.** Selection is lexical. `user_memory` is ready for a
  `pgvector` `embedding` column when the corpus outgrows term overlap.
- **The heard-transcript ledger is exact only on the streaming transport.** `ws3` gives word
  timestamps; the HTTP transport used by the quick and precise profiles does not, so those clauses
  fall back to a proportional estimate from played samples.
- **Timers do not ring.** They are tracked, spoken on request, and shown on screen, but there is no
  alarm sound or push notification when one expires.
- **One recipe at a time.** A session points at a single recipe; parallel dishes are not modelled.
