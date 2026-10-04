import { redirect } from 'next/navigation';
import { currentUser } from '@/domain/auth/guard';

export default async function Home() {
  const user = await currentUser();
  // Chat-first front door (owner direction 2026-09-15): signed-in owners land in
  // Ops Chat; the classic dashboard stays reachable at /projects.
  redirect(user ? '/ops' : '/login');
}
