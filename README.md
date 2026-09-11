# Cooking Companion

A voice-first cooking assistant. **Don't stop cooking to use a screen — just talk.**

The assistant holds the cooking state (recipe, step, servings, substitutions, timers) and the user's own history across sessions, answers hands-free, and — the part that actually matters — handles being interrupted mid-sentence without losing track of what the cook heard.

**Rime AI** is the primary spoken-output layer. Everything else — auth, recognition, reasoning, memory, tools, interruption handling — is this application's job.

---

## Rime Engine Configuration

Cooking Companion uses Rime AI for low-latency, cancellable spoken responses and dynamic speech profile rendering.

| Specification | Value | Environment Variable / Default |
| --- | --- | --- |
| **Model ID** | `coda` | `RIME_MODEL_ID` (default: `coda`) |
| **Speaker / Voice ID** | `astra` | `RIME_VOICE_ID` (default: `astra`) |
| **Language** | `en` | `RIME_LANG` (default: `en`) |
| **Audio Format** | `pcm` (raw 16-bit LE PCM, mono) | `RIME_AUDIO_FORMAT` (default: `pcm`) |
| **Sampling Rate** | `24000` Hz | `RIME_SAMPLING_RATE` (default: `24000`) |
| **WebSocket Endpoint** | `wss://users-ws.rime.ai/ws3` | `RIME_ENDPOINT` |
| **HTTP REST Endpoint** | `https://users.rime.ai/v1/rime-tts` | `RIME_HTTP_ENDPOINT` |
| **Live Catalog URL** | `https://users.rime.ai/data/voices/all-v2.json` | `RIME_CATALOG_URL` |
| **Transport Used** | **Dual Transport**: `ws3` (WebSocket JSON) + `https` (REST API) | Handled in [`src/lib/tts/rime/adapter.ts`](src/lib/tts/rime/adapter.ts) |

### Transport Strategy
- **`ws3` WebSocket Transport**: Used for streaming explanation turns. Supports low-latency chunk delivery, word-level timestamps, and source-level cancellation via `{"operation":"clear"}` when the user interrupts (barge-in).
- **`https` REST Transport**: Used for short, rate-sensitive utterances (such as timer confirmations and ingredient quantities). Rime's `ws3` protocol ignores `timeScaleFactor`, so speech profiles requiring speed adjustments (e.g. `timeScaleFactor: 1.22` for `precise`) route through HTTPS.

---

## Third-Party Services

| Service | Role | Provider / Details |
| --- | --- | --- |
| **Rime AI** | Spoken Output (TTS) | Model `coda`, Speaker `astra`, 24kHz PCM output over WS3/HTTP. |
| **Supabase** | Database & Auth | PostgreSQL database with forced Row-Level Security (RLS) and auth sessions. |
| **Groq / OpenAI API** | LLM Reasoning & Tools | Primary model `openai/gpt-oss-20b` (or `gemini-2.5-flash`); automatic fallback to `openai/gpt-oss-120b` (or `gemini-2.5-flash-lite`). |
| **Groq Whisper** | Speech-to-Text (STT) | `whisper-large-v3-turbo` model for high-accuracy spoken transcriptions. |

---

## Architecture & Region Rationale

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

### Region Selection Rationale (`bom1` / Mumbai)

`vercel.json` pins application functions to `bom1` (Mumbai). This is intentional: the Supabase PostgreSQL database is located in India. Deploying functions to Vercel's default US region (`iad1` in Virginia) introduced ~300 ms round-trip latency across the planet per database query. A single conversational turn makes multiple database round-trips before triggering the LLM, leading to unacceptable multi-second delays.

Deploying to `bom1` reduces database round trips to ~30 ms. The LLM and voice providers (which stream single responses) incur minimal extra transport latency compared to chained blocking database calls, yielding a dramatically faster user experience.

### Audio & Cancellation Design Decisions

1. **SSE Single-Stream Transport**: Audio and turn events share a single Server-Sent Events (SSE) connection (`POST /api/turn`). Aborting the client `fetch` during barge-in immediately cancels Rime synthesis, LLM generation, and running backend tools simultaneously.
2. **Context ID Scoping**: Every audio chunk emitted by Rime carries a `contextId`. Interrupted chunks from superseded turns are filtered out instantly, preventing stale audio from playing over user corrections.

---

## File Layout

```
src/
  app/                    Routes and pages (Next.js App Router)
    api/turn/             Conversational turn orchestrator (SSE)
    api/stt/              Speech-to-text upload route
    api/backchannel/      Short spoken acknowledgements ("mm-hm")
    api/{recipes,sessions,memory,timers,health}/
    cook/[sessionId]/     Hands-free cooking console UI
  components/             UI components & cooking voice console panels
  lib/
    audio/                Browser audio capture, WAV encoding, VAD policy
    auth/session.ts       Session cookie identity verification
    cooking/              Recipe scaling, substitutions, state management
    db/                   Repository pattern with user-scoped database queries
    llm/                  OpenAI-compatible LLM client with fallback handling
    memory/retrieval.ts   Lexical user memory selection
    stt/                  Whisper-compatible transcription client
    tts/                  TTS provider interface, speech profiles, speakable text
      rime/               Rime implementation: ws3 client, http client, adapter
    tools/                Server-side tools (scaling, timers, substitutions)
    voice/                Turn orchestrator, event types, backchannels, heard ledger
supabase/migrations/      PostgreSQL schema, indexes, RLS policies, starter triggers
tests/                    Vitest unit & integration test suites
public/worklets/          Audio worklets (PCM player, mic meter)
```

---

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Database Migration & Configuration

Create a project at [supabase.com](https://supabase.com) and execute the SQL migrations in order:

```
supabase/migrations/0001_schema.sql
supabase/migrations/0002_rls.sql
supabase/migrations/0003_parallel_tasks.sql
```

Migration `0002_rls.sql` enforces Row-Level Security (RLS) on all tables and installs ownership triggers so cross-user data access is strictly blocked at the database level.

For local development, disable email confirmation (Authentication → Providers → Email → uncheck "Confirm email") so sign-up logs in immediately. You can verify autoconfirm settings via CLI:

```bash
curl -s -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/settings" | grep -o '"mailer_autoconfirm":[a-z]*'
```

### 3. Environment Variables

Create `.env.local` from the example template:

```bash
cp .env.example .env.local
```

Configure the following variables:

| Variable | Source / Notes |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase Project Settings → API (safe for browser due to RLS) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only key used for database seeding (`npm run seed`) |
| `RIME_API_KEY` | [rime.ai](https://rime.ai) API key |
| `LLM_API_KEY` | [console.groq.com](https://console.groq.com) (or OpenAI / Gemini key) |
| `STT_API_KEY` | Groq API key for Whisper transcription |

Optional overrides for Rime:
- `RIME_MODEL_ID` (default: `coda`)
- `RIME_VOICE_ID` (default: `astra`)
- `RIME_LANG` (default: `en`)

### 4. Run Preflight Diagnostics

Verify all API keys, database access, live Rime voice catalog, and synthesis prior to running the app:

```bash
npm run preflight
```

### 5. Start Development Server

```bash
npm run dev
```

Open `http://localhost:3000` to register an account and start cooking.

Optional seeding script to populate starter memory and recipes:

```bash
npm run seed -- you@example.com
```

---

## Failure Behavior & Resiliency

The system is engineered to fail open for the user experience while enforcing strict error isolation:

1. **LLM Rate Limits (HTTP 429)**: Free-tier LLM providers meter models individually. If the primary model (`openai/gpt-oss-20b`) hits a rate limit, the system automatically falls back to `openai/gpt-oss-120b` (or `gemini-2.5-flash-lite`) without throwing an exception or interrupting ongoing tool execution.
2. **Missing Rime Configuration / 503 Provider Error**: If `RIME_API_KEY` is missing or invalid, the TTS layer throws a `ProviderError` (503). The backend descriptor returns `configured: false`, allowing the UI to present a clear configuration notification rather than crashing.
3. **Network Interruption / User Barge-In**: Aborting an in-flight turn cancels the fetch connection. The orchestrator dispatches `{"operation":"clear"}` to Rime, halting synthesis instantly. The `heard-ledger` truncates the turn's transcript to match only the audio samples actually output by the PCM player worklet.
4. **STT Failures / Unintelligible Speech**: If speech recognition fails or returns empty text, the turn gracefully prompts the user or allows quick replay via the "Say that again" trigger.
5. **Audio Buffer Underflow**: The `pcm-player` worklet monitors queue depth and automatically re-primes without audio pop or glitch artifacts when data resumes.

---

## Known Limitations

- **Hardware Microphone Testing**: Microphone recording formats (WAV encoding, PCM framing) are verified via `npm run verify:audio`. However, hardware microphone gain and onset thresholds in noisy kitchen environments depend on device hardware and browser VAD settings.
- **Hardware Echo Cancellation (AEC)**: The microphone remains active while Rime speaks. On devices with poor hardware AEC, speaker playback may bleed into the microphone. A `duckedMultiplier` is applied during playback to mitigate false barge-ins.
- **Timing-Based Backchanneling**: Backchannel acknowledgements ("mm-hm") trigger based on speech duration thresholds (3.5s speech, 9s gap) rather than semantic intent analysis.
- **Lexical Memory Search**: User preferences and memory search currently rely on keyword/term overlap. Migration to `pgvector` semantic embeddings is planned for larger memory sets.
- **Timestamp Precision Differences**: Rime's `ws3` WebSocket transport emits native word-level timestamps. HTTP REST synthesis (used for speed-scaled speech profiles) estimates word boundaries proportionally based on sample length.
- **Visual & Spoken Timers Only**: Cooking timers update on screen and announce when queried, but do not emit an audio alarm sound or browser push notification upon expiration.
- **Single Active Recipe Session**: A cooking session models one recipe at a time; concurrent multi-recipe management is not supported.

---

## Evidence & Verification Commands

See [`RIME_EVIDENCE.md`](file:///c:/Users/filza/Downloads/forge/cooking-companion/RIME_EVIDENCE.md) for full empirical benchmarks and test logs.

```bash
npm test          # Run Vitest test suite (278 tests across 21 test files)
npm run typecheck # TypeScript static type checking
npm run lint      # ESLint checks
npm run preflight # Live provider & Rime voice catalog verification
npm run verify:audio # Round-trip Rime PCM -> WAV -> Whisper STT transcription
npm run verify:rls   # Verify PostgreSQL Row-Level Security data isolation
```
