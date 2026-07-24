import { z } from 'zod';

/**
 * Browser-safe environment. ONLY the two Supabase publishable values live here.
 * If you are about to add a variable to this file, stop and ask whether it is a
 * secret; if it is, it belongs in env.server.ts.
 */

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

export function publicEnv(): PublicEnv {
  // Next.js inlines NEXT_PUBLIC_* at build time; they must be referenced
  // statically for the replacement to happen.
  const parsed = publicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  if (!parsed.success) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set.',
    );
  }
  return parsed.data;
}
