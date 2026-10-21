import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Qoneqt Test Runner",
  description:
    "Upload an Android or iOS build, run Maestro tests live, download the report.",
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
