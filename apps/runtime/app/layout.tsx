import type { Metadata } from "next";
import "@rescript/renderer/questions.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Survey",
  description: "Rescript survey runtime",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
