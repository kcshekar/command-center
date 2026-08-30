import type { Metadata } from "next";
import { Bricolage_Grotesque, Hanken_Grotesk, Spline_Sans_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { WorkspaceProvider } from "@/lib/workspace-context";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";

const sans = Hanken_Grotesk({
  variable: "--font-sans",
  subsets: ["latin"],
});

const display = Bricolage_Grotesque({
  variable: "--font-heading",
  subsets: ["latin"],
});

const mono = Spline_Sans_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Command Center",
  description: "Secrets, vault, knowledge base, and financial operations — one place.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${display.variable} ${mono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <ThemeProvider>
          <AuthProvider>
            <WorkspaceProvider>
              {children}
              <Toaster richColors position="bottom-right" />
            </WorkspaceProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
