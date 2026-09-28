import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import Link from "next/link";
import { SESSION_COOKIE, authEnabled, isDemo, isValidSession } from "@/lib/auth";
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

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const demo = isDemo();
  const signedIn = await isValidSession((await cookies()).get(SESSION_COOKIE)?.value);
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
      <body className="min-h-screen font-sans">
        {demo && (
          <div className="bg-accent px-4 py-1.5 text-center text-xs font-medium text-white">
            Demo · all numbers are made up · read-only — click around to explore
          </div>
        )}
        <header className="border-b border-border bg-surface">
          <nav className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
            <Link href="/" className="mr-4 font-semibold tracking-tight">
              PowerWheel
            </Link>
            {signedIn && NAV.map((n) => (
              <Link key={n.href} href={n.href} className="text-sm text-muted hover:text-foreground">
                {n.label}
              </Link>
            ))}
            {authEnabled() && signedIn && (
              <form action="/auth/logout" method="post" className="ml-auto">
                <button className="text-sm text-muted hover:text-foreground">Sign out</button>
              </form>
            )}
          </nav>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
