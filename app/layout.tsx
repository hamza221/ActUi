import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  return {
    title: "ActUI — GitHub Actions, running locally",
    description: "A fast, accessible local dashboard for running GitHub Actions with nektos/act.",
    icons: { icon: "/favicon.png", shortcut: "/favicon.png" },
    openGraph: {
      title: "ActUI — Run your CI. Stay in flow.",
      description: "Discover, configure, and watch GitHub Actions run locally with nektos/act.",
      type: "website",
      images: [{ url: `${origin}/og.png`, width: 1200, height: 630, alt: "ActUI local CI workflow dashboard" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "ActUI — Run your CI. Stay in flow.",
      description: "A shared local CI workbench for humans and coding agents.",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
