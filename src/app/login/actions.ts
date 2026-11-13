'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/domain/auth/supabase';
import { safeNext } from '@/lib/safe-next';

const credentialsSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
});

export interface AuthFormState {
  error: string | null;
}

export async function signIn(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    // Uniform message: no user-enumeration oracle.
    return { error: 'Sign-in failed. Check your email and password.' };
  }
  // Return the owner WHERE THEY WERE HEADED (middleware put it in the form's hidden `next`),
  // defaulting chat-first. Hardcoding /projects here is what made the PWA always open the
  // dashboard no matter what start_url asked for.
  redirect(safeNext(formData.get('next')));
}

export async function signUp(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signUp(parsed.data);
  if (error) {
    return { error: 'Sign-up failed. Try a different email or a stronger password.' };
  }
  redirect(safeNext(formData.get('next')));
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/login');
}
