import { createServerSupabase } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  return Response.redirect(new URL('/login', request.url), 303);
}
