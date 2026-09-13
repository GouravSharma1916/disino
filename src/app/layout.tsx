import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Disino | Project rescue",
  description: "Evidence-led ownership drift detection.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
