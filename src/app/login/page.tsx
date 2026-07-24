import { redirect } from 'next/navigation';
import { currentUser } from '@/domain/auth/guard';
import { LoginForm } from './login-form';

export default async function LoginPage() {
  const user = await currentUser();
  if (user) redirect('/projects');

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight">
            King <span className="text-[var(--accent)]">AI Ops</span> Hub
          </h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            One control plane. Two model vendors. Zero context bleed.
          </p>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6">
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
