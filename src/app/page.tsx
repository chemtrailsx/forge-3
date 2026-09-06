import { redirect } from 'next/navigation';
import { getUserContext } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const ctx = await getUserContext();
  redirect(ctx ? '/dashboard' : '/login');
}
