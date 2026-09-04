import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Fraunces, Instrument_Sans, JetBrains_Mono } from 'next/font/google';
import { Providers } from '@/components/shell/Providers';
import { SkipLink } from '@/components/shell/SkipLink';
import { TopBar } from '@/components/shell/TopBar';
import { CommandPalette } from '@/components/shell/CommandPalette';
import { HoverPreviewHost } from '@/components/shell/HoverPreviewHost';
import { ToastHost } from '@/components/ui/ToastHost';
import { CardGLProvider } from '@/components/card/CardGLProvider';
import './globals.css';

const fraunces = Fraunces({ subsets: ['latin'], axes: ['opsz', 'SOFT', 'WONK'], variable: '--font-fraunces', display: 'swap', style: ['normal', 'italic'] });
const instrument = Instrument_Sans({ subsets: ['latin'], variable: '--font-instrument', display: 'swap' });
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Vault', template: '%s — Vault' },
  description: 'Every Magic: The Gathering card ever printed, browsable, buildable and playable against a reactive AI.',
};
export const viewport: Viewport = { themeColor: '#0A0A0D', colorScheme: 'dark', viewportFit: 'cover' };

export default function RootLayout({ children, modal }: { children: ReactNode; modal: ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${instrument.variable} ${jetbrains.variable}`}>
      <body>
        <Providers>
          <SkipLink />
          <TopBar />
          <CardGLProvider>
            <main id="main" tabIndex={-1}>{children}</main>
            {modal}
            <CommandPalette />
            <HoverPreviewHost />
          </CardGLProvider>
          <ToastHost />
        </Providers>
      </body>
    </html>
  );
}
