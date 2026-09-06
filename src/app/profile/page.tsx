import { redirect } from 'next/navigation';
import { MemoryManager } from '@/components/MemoryManager';
import { TopBar } from '@/components/TopBar';
import { getUserContext } from '@/lib/auth/session';
import { dbFor } from '@/lib/db/context';
import { listMemory } from '@/lib/db/memory';
import { getProfile } from '@/lib/db/profiles';
import { providerDescriptors } from '@/lib/env';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const ctx = await getUserContext();
  if (!ctx) redirect('/login');

  const db = dbFor(ctx);
  const [profile, memory] = await Promise.all([getProfile(db), listMemory(db)]);
  const providers = providerDescriptors();

  return (
    <main className="page">
      <TopBar email={ctx.email} current="profile" />

      <div className="grid two">
        <MemoryManager initial={memory} />

        <div className="stack">
          <section className="card">
            <h3>Preferences</h3>
            <ul className="plain">
              <li>
                <span>Usual servings</span>
                <span className="muted">{profile?.preferences.defaultServings ?? 'not set'}</span>
              </li>
              <li>
                <span>Spice level</span>
                <span className="muted">{profile?.preferences.spiceLevel ?? 'not set'}</span>
              </li>
              <li>
                <span>Dietary</span>
                <span className="muted">
                  {profile?.preferences.dietary?.join(', ') || 'none recorded'}
                </span>
              </li>
            </ul>
            <p className="muted small" style={{ marginTop: 12, marginBottom: 0 }}>
              These are set by speaking while you cook — the assistant saves them itself.
            </p>
          </section>

          <section className="card">
            <h3>Voice pipeline</h3>
            <ul className="plain small">
              <li>
                <span>Speech</span>
                <span className="muted">
                  {providers.tts.configured
                    ? `rime · ${providers.tts.modelId} · ${providers.tts.voiceId} · ${providers.tts.samplingRate} Hz`
                    : 'not configured'}
                </span>
              </li>
              <li>
                <span>Recognition</span>
                <span className="muted">{providers.stt.model ?? 'not configured'}</span>
              </li>
              <li>
                <span>Reasoning</span>
                <span className="muted">{providers.llm.model ?? 'not configured'}</span>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}
