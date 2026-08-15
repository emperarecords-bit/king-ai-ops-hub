import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'King AI Operations Hub',
  description: 'Delegate work to OpenAI and Anthropic models across isolated project workspaces.',
  // Installable app (PWA): manifest + icons + iOS standalone hints, so the hub
  // lives on the owner's phone home screen and opens full-screen to the Inbox.
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [{ url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'King Hub',
  },
};

export const viewport: Viewport = {
  themeColor: '#0b0e14',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
