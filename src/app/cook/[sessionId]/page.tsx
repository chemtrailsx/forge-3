import { notFound, redirect } from 'next/navigation';
import { VoiceConsole } from '@/components/cooking/VoiceConsole';
import { TopBar } from '@/components/TopBar';
import { getUserContext } from '@/lib/auth/session';
import { loadCookingState } from '@/lib/cooking/state';
import { dbFor } from '@/lib/db/context';
import { recentTurns } from '@/lib/db/turns';
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

  const db = dbFor(ctx);

  let snapshot;
  let history;
  try {
    // Concurrently: neither needs the other, and both are round trips to a
    // database that the cook is waiting on before they can say anything.
    [snapshot, history] = await Promise.all([
      loadCookingState(db, sessionId).then((state) => state.snapshot),
      recentTurns(db, sessionId, 20),
    ]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const providers = providerDescriptors();

  return (
    <main className="page fullscreen">
      <TopBar email={ctx.email} current="cook" />
      
      <VoiceConsole
        sessionId={sessionId}
        initialState={snapshot}
        // What was already said here, so resuming shows the conversation the
        // cook is coming back to rather than an empty feed.
        initialTranscript={history.map((turn) => ({
          id: turn.id,
          role: turn.role,
          // What they actually heard, when the turn was cut off — repeating
          // words that never reached them would be a false record.
          text: turn.heardText ?? turn.text,
          interrupted: turn.interrupted,
        }))}
        sampleRate={providers.tts.samplingRate}
        ttsConfigured={providers.tts.configured}
      />
    </main>
  );
}
