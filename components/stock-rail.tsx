"use client";

import { motion, useReducedMotion } from "motion/react";
import Image from "next/image";
import type { Variants } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { stocks } from "@/lib/stocks";
import type { StockSymbol } from "@/lib/stocks";

type Props = {
  selected: StockSymbol;
  onSelect: (symbol: StockSymbol) => void;
  availableSymbols?: ReadonlySet<StockSymbol>;
  disabled?: boolean;
};

const railItem: Variants = {
  hidden: { opacity: 0, y: 8, scale: 0.97 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.4, ease: [0.2, 0.8, 0.2, 1] } },
};

export function StockRail({ selected, onSelect, availableSymbols, disabled = false }: Props) {
  const railRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startScrollLeft: number;
    moved: boolean;
    lastX: number;
    lastTime: number;
    velocity: number;
  } | null>(null);
  const glideRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const reduceMotion = useReducedMotion();
  const [edges, setEdges] = useState({ left: false, right: false });

  const updateEdges = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const overflow = rail.scrollWidth - rail.clientWidth;
    setEdges({
      left: overflow > 2 && rail.scrollLeft > 2,
      right: overflow > 2 && rail.scrollLeft < overflow - 2,
    });
  }, []);

  useLayoutEffect(() => {
    updateEdges();
    window.addEventListener("resize", updateEdges);
    return () => window.removeEventListener("resize", updateEdges);
  }, [updateEdges]);

  const stopGlide = useCallback(() => {
    if (glideRef.current === null) return;
    cancelAnimationFrame(glideRef.current);
    glideRef.current = null;
  }, []);

  useEffect(() => stopGlide, [stopGlide]);

  const glide = useCallback(
    (initialVelocity: number) => {
      const rail = railRef.current;
      if (!rail) return;
      let velocity = initialVelocity;
      let previous = performance.now();
      const step = (now: number) => {
        const elapsed = Math.min(now - previous, 32);
        previous = now;
        velocity *= Math.pow(0.9945, elapsed);
        const limit = rail.scrollWidth - rail.clientWidth;
        const next = Math.min(Math.max(rail.scrollLeft - velocity * elapsed, 0), limit);
        const stopped = next === rail.scrollLeft && Math.abs(velocity) > 0;
        rail.scrollLeft = next;
        updateEdges();
        if (Math.abs(velocity) < 0.015 || stopped) {
          glideRef.current = null;
          return;
        }
        glideRef.current = requestAnimationFrame(step);
      };
      glideRef.current = requestAnimationFrame(step);
    },
    [updateEdges],
  );

  const nudge = (direction: -1 | 1) => {
    railRef.current?.scrollBy({
      left: direction * Math.max(180, (railRef.current?.clientWidth ?? 320) * 0.72),
      behavior: reduceMotion ? "auto" : "smooth",
    });
  };

  const beginDrag = (event: PointerEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    if (!rail || event.pointerType !== "mouse" || event.button !== 0) return;
    stopGlide();
    suppressClickRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: rail.scrollLeft,
      moved: false,
      lastX: event.clientX,
      lastTime: event.timeStamp,
      velocity: 0,
    };
  };

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    const drag = dragRef.current;
    if (!rail || !drag || drag.pointerId !== event.pointerId) return;
    const distance = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(distance) > 4) {
      drag.moved = true;
      rail.setPointerCapture(event.pointerId);
    }
    if (!drag.moved) return;
    event.preventDefault();

    const elapsed = event.timeStamp - drag.lastTime;
    if (elapsed > 0) {
      const sample = (event.clientX - drag.lastX) / elapsed;
      drag.velocity = drag.velocity * 0.7 + sample * 0.3;
      drag.lastX = event.clientX;
      drag.lastTime = event.timeStamp;
    }

    rail.scrollLeft = drag.startScrollLeft - distance;
    updateEdges();
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    const drag = dragRef.current;
    if (!rail || !drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);
    if (!drag.moved) return;
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);

    const stale = event.timeStamp - drag.lastTime > 90;
    if (reduceMotion || stale || Math.abs(drag.velocity) < 0.05) return;
    glide(drag.velocity);
  };

  const cancelDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    suppressClickRef.current = false;
  };

  const suppressDraggedClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = false;
  };

  const moveSelection = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const enabledIndices = stocks.flatMap((stock, stockIndex) =>
      availableSymbols?.has(stock.symbol) === false ? [] : [stockIndex],
    );
    if (enabledIndices.length === 0) return;

    const currentPosition = enabledIndices.indexOf(index);
    let nextPosition: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextPosition = (currentPosition + 1) % enabledIndices.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextPosition = (currentPosition - 1 + enabledIndices.length) % enabledIndices.length;
    } else if (event.key === "Home") {
      nextPosition = 0;
    } else if (event.key === "End") {
      nextPosition = enabledIndices.length - 1;
    }
    if (nextPosition === null) return;

    event.preventDefault();
    const nextIndex = enabledIndices[nextPosition];
    onSelect(stocks[nextIndex].symbol);
    optionRefs.current[nextIndex]?.focus();
    optionRefs.current[nextIndex]?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "nearest",
      inline: "nearest",
    });
  };

  return (
    <div className="relative -mx-1 min-w-0 max-w-full overflow-hidden px-1">
      <div
        ref={railRef}
        data-testid="stock-rail"
        role="radiogroup"
        aria-label="Choose one of 13 Coinbase tokenized stocks"
        onScroll={updateEdges}
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={finishDrag}
        onPointerCancel={cancelDrag}
        onPointerLeave={(event) => {
          if (!dragRef.current?.moved) cancelDrag(event);
        }}
        onClickCapture={suppressDraggedClick}
        className="stock-rail flex w-full min-w-0 gap-2 overflow-x-auto py-0.5"
      >
        {stocks.map((stock, index) => {
          const available = availableSymbols?.has(stock.symbol) ?? true;
          const optionDisabled = disabled || !available;
          return (
            <motion.div key={stock.symbol} variants={railItem} className="shrink-0">
              <motion.button
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                type="button"
                role="radio"
                aria-checked={selected === stock.symbol}
                aria-label={`${stock.name} · ${stock.symbol}`}
                disabled={optionDisabled}
                tabIndex={selected === stock.symbol ? 0 : -1}
                onClick={() => onSelect(stock.symbol)}
                onKeyDown={(event) => moveSelection(event, index)}
                whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                className="stock-packet group relative flex min-w-[124px] items-center gap-2 overflow-hidden rounded-[13px] border border-ink/12 bg-[#fffdf8] px-2 py-1.5 text-left transition-colors aria-checked:border-ink aria-checked:bg-ink aria-checked:text-cream disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-3 focus-visible:outline-meadow/50"
              >
                <Image
                  src={`/stocks/${stock.symbol}.png`}
                  alt=""
                  width={28}
                  height={28}
                  unoptimized
                  draggable={false}
                  className="size-7 shrink-0 rounded-full bg-white object-contain shadow-sm"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[11.5px] font-extrabold leading-none">{stock.symbol}</span>
                  <span className="mt-1 truncate text-[9.5px] font-bold leading-none text-ink-soft group-aria-checked:text-cream/65">
                    {stock.name}
                  </span>
                </span>
                {!available && <span className="sr-only">Unavailable on this test network</span>}
              </motion.button>
            </motion.div>
          );
        })}
      </div>

      {edges.left && (
        <div
          data-testid="stock-fade-left"
          className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-cream via-cream/90 to-transparent"
        />
      )}
      {edges.right && (
        <div
          data-testid="stock-fade-right"
          className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-cream via-cream/90 to-transparent"
        />
      )}
      {edges.left && (
        <button
          type="button"
          onClick={() => nudge(-1)}
          aria-label="Show earlier stocks"
          className="rail-arrow left-1"
        >
          <span aria-hidden="true">‹</span>
        </button>
      )}
      {edges.right && (
        <button
          type="button"
          onClick={() => nudge(1)}
          aria-label="Show later stocks"
          className="rail-arrow right-1"
        >
          <span aria-hidden="true">›</span>
        </button>
      )}
    </div>
  );
}
