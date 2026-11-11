import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Loops · TokenLogic Terminal",
  description: "Leveraged loop positions on Aave V3 Core, read on-chain.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
