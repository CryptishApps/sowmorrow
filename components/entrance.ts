"use client";

import { stagger } from "motion/react";
import type { Variants } from "motion/react";
import { useEffect, useState } from "react";
import { stocks } from "@/lib/stocks";

export type Entrance = "load" | "switch";

export const entranceEase = [0.2, 0.8, 0.2, 1] as const;
const entranceSettleFallbackMs = 2500;

export function useEntranceSettled(reduceMotion: boolean | null) {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(true), entranceSettleFallbackMs);
    return () => window.clearTimeout(timer);
  }, []);
  return { scrollable: settled || reduceMotion === true, settle: () => setSettled(true) };
}

const entranceDelay: Record<Entrance, number> = { load: 0.3, switch: 0.06 };
const itemInterval = 0.06;
const stockInterval = 0.028;
const railPosition = 1;

export const entranceItem: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: entranceEase } },
};

export const stockGroup: Variants = {
  hidden: {},
  show: { transition: { delayChildren: stagger(stockInterval) } },
};

export function plantEntrance(entrance: Entrance): Variants {
  const railSpan = stocks.length * stockInterval;
  return {
    hidden: {},
    show: {
      transition: {
        delayChildren: (index: number) =>
          entranceDelay[entrance] + index * itemInterval + (index > railPosition ? railSpan : 0),
      },
    },
  };
}

export function claimEntrance(entrance: Entrance): Variants {
  return {
    hidden: {},
    show: { transition: { delayChildren: stagger(0.09, { startDelay: entranceDelay[entrance] }) } },
  };
}
