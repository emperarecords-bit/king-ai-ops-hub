import { NextResponse } from 'next/server';
import { testFakeProvidersEnabled } from '@/providers/registry';

/**
 * TEST-ONLY probe: reports whether THIS running server has the fenced in-app fake providers selected, so a
 * browser run-to-result spec can verify the exact server it is about to drive is fake-backed BEFORE dispatching
 * any run (fail closed — never run against an unknown/real-provider server). Returns 404 in production so it is
 * not a surface there; in non-production it returns `{ fake }`, or 503 when the fence throws (flag set on an
 * incompatible runtime) — either non-true answer makes the spec refuse to run.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return new NextResponse('Not found', { status: 404 });
  }
  try {
    return NextResponse.json({ fake: testFakeProvidersEnabled() });
  } catch (err) {
    return NextResponse.json({ fake: false, error: err instanceof Error ? err.name : 'error' }, { status: 503 });
  }
}
