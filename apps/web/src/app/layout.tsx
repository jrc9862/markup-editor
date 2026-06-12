import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Markup',
  description: 'Google Docs for Markdown',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
