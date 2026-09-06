import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cooking Companion',
  description: 'A voice-first cooking assistant that knows when to listen, when to speak, and when to stop.',
};

export const viewport: Viewport = {
  themeColor: '#12100e',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
