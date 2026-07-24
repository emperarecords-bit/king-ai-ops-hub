import { redirect } from 'next/navigation';
import { currentUser } from '@/domain/auth/guard';

export default async function Home() {
  const user = await currentUser();
  redirect(user ? '/projects' : '/login');
}
