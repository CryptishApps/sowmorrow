"use client";

import { Fraunces, Nunito } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
});
const nunito = Nunito({ variable: "--font-nunito", subsets: ["latin"] });

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en" className={`${fraunces.variable} ${nunito.variable} h-full`}>
      <body className="min-h-full">
        <title>The garden needs a moment — Sowmorrow</title>
        <main className="grid min-h-dvh place-items-center bg-sky-deep px-4 py-10 text-center">
          <section className="w-full max-w-[440px] rounded-[26px] border border-ink/10 bg-cream px-6 pb-6 pt-7 text-ink shadow-card sm:px-8">
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-ink-soft">
              Something went wrong
            </p>
            <h1 className="display mt-3 text-balance text-[34px] leading-[1.05]">
              The garden needs a moment.
            </h1>
            <p className="mt-3 text-pretty text-[15px] leading-relaxed text-ink-soft">
              Sowmorrow could not load at all. No wallet action was submitted. Reload, or come back in a
              minute.
            </p>
            {error.digest && (
              <p className="mt-3 break-all rounded-xl bg-cream-deep/70 px-3 py-2 font-mono text-[10px] text-ink-soft">
                Reference {error.digest}
              </p>
            )}
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button type="button" onClick={() => retry()} className="primary-button">
                Try again
              </button>
              <Link
                href="/"
                className="text-[13px] font-extrabold text-sky-deep underline underline-offset-2"
              >
                Back to the meadow
              </Link>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
