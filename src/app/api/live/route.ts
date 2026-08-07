import { NextResponse } from 'next/server';

/** Dependency-free process liveness. Dependency readiness remains `/api/health`. */
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ status: 'alive' });
}
