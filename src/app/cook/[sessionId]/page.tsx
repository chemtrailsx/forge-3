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

  // Loading through the same path the voice loop uses means a session
  // belonging to somebody else is a 404 here for exactly the same reason it is
  // unreachable there.
  let snapshot;
  try {
    snapshot = (await loadCookingState(dbFor(ctx), sessionId)).snapshot;
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const providers = providerDescriptors();

  return (
    <main className="page">
      <TopBar email={ctx.email} current="cook" />
      <h1 style={{ marginBottom: 18 }}>
        {snapshot.awaitingRecipe ? 'Ready when you are' : snapshot.title}
      </h1>
      <VoiceConsole
        sessionId={sessionId}
        initialState={snapshot}
        sampleRate={providers.tts.samplingRate}
        ttsConfigured={providers.tts.configured}
      />
    </main>
  );
}
