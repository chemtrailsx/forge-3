import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cooking Companion - Voice-First Kitchen Assistant',
  description: 'A voice-first cooking assistant that knows when to listen, when to speak, and when to stop.',
};

export const viewport: Viewport = {
  // Matches the page background in each theme, so the browser chrome on a
  // phone does not sit in a colour the app never uses.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf8f5' },
    { media: '(prefers-color-scheme: dark)', color: '#161513' },
  ],
  width: 'device-width',
  initialScale: 1,
};

/*
 * Applies the saved theme before the first paint.
 *
 * Without this the page renders in the default theme and then corrects itself,
 * and a white flash in a dark kitchen is worse than no dark mode at all. It
 * has to be inline and synchronous — anything deferred is already too late.
 */
const THEME_SCRIPT = `try{var t=localStorage.getItem('cooking-companion-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/*
          The rule this disables is about `pages/_document.js`, where a font
          link loads for one page only. This is the App Router's root layout,
          which wraps every page, so the warning does not apply.
        */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
