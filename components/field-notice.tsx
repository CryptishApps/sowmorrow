"use client";

import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import type { ReactNode } from "react";
import { HeroBackdrop } from "@/components/hero-backdrop";
import { Logo } from "@/components/logo";

type Props = {
  code: string;
  title: string;
  body: string;
  detail?: string;
  action?: ReactNode;
};

export function FieldNotice({ code, title, body, detail, action }: Props) {
  const reduce = useReducedMotion();
  const rise = (delay: number) =>
    reduce
      ? { initial: false as const, animate: { opacity: 1, y: 0 }, transition: { duration: 0 } }
      : {
          initial: { opacity: 0, y: 12 },
          animate: { opacity: 1, y: 0 },
          transition: { delay, duration: 0.55, ease: [0.2, 0.8, 0.2, 1] as const },
        };

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-sky-deep px-4 py-10 text-center">
      <HeroBackdrop />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[30dvh] bg-gradient-to-t from-cream via-cream/50 to-transparent" />

      <div className="relative z-10 flex w-full max-w-[440px] flex-col items-center">
        <motion.div {...rise(0)}>
          <Link href="/" aria-label="Sowmorrow home">
            <Logo />
          </Link>
        </motion.div>

        <motion.section
          {...rise(0.12)}
          aria-labelledby="field-notice-title"
          className="mt-6 w-full rounded-[26px] border border-ink/10 bg-cream px-6 pb-6 pt-7 text-ink shadow-card sm:px-8"
        >
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-ink-soft">{code}</p>
          <h1 id="field-notice-title" className="display mt-3 text-balance text-[34px] leading-[1.05]">
            {title}
          </h1>
          <p className="mt-3 text-pretty text-[15px] leading-relaxed text-ink-soft">{body}</p>
          {detail && (
            <p className="mt-3 break-all rounded-xl bg-cream-deep/70 px-3 py-2 font-mono text-[10px] text-ink-soft">
              {detail}
            </p>
          )}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">{action}</div>
        </motion.section>
      </div>
    </main>
  );
}

export function MeadowLink() {
  return (
    <Link href="/" className="text-[13px] font-extrabold text-sky-deep underline underline-offset-2">
      Back to the meadow
    </Link>
  );
}
