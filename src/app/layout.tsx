import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'King AI Operations Hub',
  description: 'Delegate work to OpenAI and Anthropic models across isolated project workspaces.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
