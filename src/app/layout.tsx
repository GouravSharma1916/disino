import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Disino | Keep critical work moving",
  description: "Find ownership drift across GitHub, Slack, and Notion before critical work goes quiet.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
