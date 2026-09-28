import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "PowerWheel",
  description: "Wheel strategy tracking and reporting",
};

const NAV = [
  { href: "/", label: "Reports" },
  { href: "/positions", label: "Positions" },
  { href: "/trades/new", label: "New trade" },
  { href: "/activity", label: "Activity" },
  { href: "/snapshots", label: "Account value" },
  { href: "/settings", label: "Settings" },
];

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
      <body className="min-h-screen font-sans">
        <header className="border-b border-border bg-surface">
          <nav className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
            <Link href="/" className="mr-4 font-semibold tracking-tight">
              PowerWheel
            </Link>
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="text-sm text-muted hover:text-foreground">
                {n.label}
              </Link>
            ))}
          </nav>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
