"use client";

import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { type Face, GiftWidget } from "@/components/gift-widget";
import { HeroBackdrop } from "@/components/hero-backdrop";
import { Logo } from "@/components/logo";
import { Tree } from "@/components/tree";
import type { AppDeployment } from "@/lib/contracts/config";

type Props = { deployment: AppDeployment };

export function Hero({ deployment }: Props) {
  const [face, setFace] = useState<Face>("plant");
  const [plants, setPlants] = useState<number[]>([]);
  const [claimId, setClaimId] = useState(0);
  const reduce = useReducedMotion();

  const rise = (delay: number) =>
    reduce
      ? {
          initial: false as const,
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0 },
        }
      : {
          initial: { opacity: 0, y: 14 },
          animate: { opacity: 1, y: 0 },
          transition: { delay, duration: 0.55, ease: [0.2, 0.8, 0.2, 1] as const },
        };

  return (
    <main className="relative min-h-dvh overflow-x-clip bg-sky-deep sm:overflow-clip">
      <HeroBackdrop />

      <div className="pointer-events-none absolute bottom-0 right-[-6vw] h-[76dvh] max-h-[900px] min-h-[520px] opacity-70 sm:opacity-100 lg:right-[-2vw] xl:right-[0vw]">
        <Tree plants={plants} claimId={claimId} startDelay={1.15} />
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[26dvh] bg-gradient-to-t from-cream via-cream/50 to-transparent" />

      <div className="relative z-10 mx-auto flex w-full max-w-[680px] flex-col items-center px-4 pt-[3dvh] text-center sm:h-dvh sm:pt-0">
        <div className="flex w-full flex-col items-center sm:min-h-0 sm:flex-1 sm:justify-center sm:pb-[1dvh]">
          <motion.div {...rise(0)}>
            <Logo />
          </motion.div>

          <motion.h1
            {...rise(0.06)}
            className="display text-shadow-sky mt-5 text-balance text-[40px] leading-[1.02] text-cloud sm:mt-[3.2dvh] sm:max-w-none sm:text-[clamp(42px,6.4dvh-4px,64px)] sm:leading-[1.02]"
          >
            Plant a stock for someone&rsquo;s tomorrow.
          </motion.h1>

          <motion.p
            {...rise(0.12)}
            className="text-shadow-sky mt-3 max-w-[44ch] text-pretty text-[16px] leading-relaxed text-cloud/90 sm:mt-[1.8dvh] sm:max-w-[54ch] sm:text-[clamp(15px,1.85dvh,17px)] sm:leading-[1.45]"
          >
            Sowmorrow locks a Coinbase tokenized stock on Base as a gift. It stays planted until the date you
            choose, then whoever you sent it to claims it.
          </motion.p>
        </div>

        <motion.div
          {...rise(0.2)}
          className="mt-[5dvh] w-full max-w-[540px] shrink-0 sm:mt-0 sm:max-w-[620px]"
        >
          <GiftWidget
            deployment={deployment}
            face={face}
            onFaceChange={setFace}
            onPlant={() => setPlants((p) => [...p, Date.now()])}
            onClaim={() => setClaimId(Date.now())}
          />
        </motion.div>
      </div>
    </main>
  );
}
