"use client";

import { useReducedMotion } from "motion/react";
import Image from "next/image";
import { useState } from "react";
import heroBg from "@/public/hero-bg.jpg";

export function HeroBackdrop() {
  const [loaded, setLoaded] = useState(false);
  const reduce = useReducedMotion();
  return (
    <Image
      src={heroBg}
      alt=""
      fill
      preload
      sizes="100vw"
      quality={82}
      onLoad={() => setLoaded(true)}
      className={
        "object-cover object-bottom " +
        (reduce ? "" : "transition-opacity duration-700 ease-out ") +
        (loaded ? "opacity-100" : "opacity-0")
      }
      aria-hidden="true"
    />
  );
}
