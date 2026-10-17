import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'Audit Trail', description: 'Live change history captured with Debezium' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="nav">
          <a href="/shop">Shop</a>
          <a href="/">Audit Trail</a>
        </nav>
        {children}
      </body>
    </html>
  );
}
