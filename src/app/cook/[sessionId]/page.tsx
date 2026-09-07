import { notFound, redirect } from 'next/navigation';
import { VoiceConsole } from '@/components/cooking/VoiceConsole';
import { TopBar } from '@/components/TopBar';
import { getUserContext } from '@/lib/auth/session';
import { loadCookingState } from '@/lib/cooking/state';
import { dbFor } from '@/lib/db/context';
import { providerDescriptors } from '@/lib/env';
import { NotFoundError } from '@/lib/errors';
import { uuidSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export default async function CookPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const ctx = await getUserContext();
  if (!ctx) redirect('/login');

  const { sessionId } = await params;
  if (!uuidSchema.safeParse(sessionId).success) notFound();

  let snapshot;
  try {
    snapshot = (await loadCookingState(dbFor(ctx), sessionId)).snapshot;
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const providers = providerDescriptors();

  return (
    <main className="page fullscreen">
      <TopBar email={ctx.email} current="cook" />
      
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, padding: '0 8px' }}>
        <div>
          <div className="section-label">Active Culinary Session</div>
          <h1 style={{ margin: 0, fontSize: '1.75rem', letterSpacing: '-0.02em' }}>
            {snapshot.awaitingRecipe ? 'Ready when you are' : snapshot.title}
          </h1>
        </div>
        {!snapshot.awaitingRecipe ? (
          <span className="badge servings" style={{ fontSize: '0.82rem', padding: '6px 14px' }}>
            {snapshot.servings} servings
          </span>
        ) : null}
      </div>

      <VoiceConsole
        sessionId={sessionId}
        initialState={snapshot}
        sampleRate={providers.tts.samplingRate}
        ttsConfigured={providers.tts.configured}
      />
    </main>
  );
}
