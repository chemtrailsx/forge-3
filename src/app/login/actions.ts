'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * Email + password auth via Supabase.
 *
 * Server actions rather than a client-side call, so the session cookie is set
 * by the server and the browser never handles the token itself.
 */

const credentialsSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.'),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
});

export type AuthState = { error: string | null; message: string | null };

export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid details.', message: null };
  }

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    // Deliberately does not distinguish "no such user" from "wrong password".
    return { error: 'Those details did not match an account.', message: null };
  }

  revalidatePath('/', 'layout');
  redirect('/dashboard');
}

export async function signUp(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid details.', message: null };
  }

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.signUp(parsed.data);
  if (error) {
    return { error: error.message, message: null };
  }

  // With email confirmation enabled there is no session yet and the user has
  // to click the link first. With it disabled, sign-in is immediate.
  if (data.session) {
    revalidatePath('/', 'layout');
    redirect('/dashboard');
  }

  return { error: null, message: 'Check your email to confirm the account, then sign in.' };
}
