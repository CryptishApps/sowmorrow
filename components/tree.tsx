"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";

type Props = { plants: number[]; claimId: number; startDelay?: number };

type Branch = {
  d: string;
  grain: string[];
  highlight: string;
  level: number;
  delay: number;
  x0: number;
  y0: number;
  x: number;
  y: number;
};
type LeafCluster = { x: number; y: number; r: number; level: number; delay: number; leaves: Leaf[] };
type Leaf = { x: number; y: number; s: number; rot: number; fill: string };

const shadow = ["#173f1e", "#1f5226"];
const mids = ["#2f7a2e", "#3a8f35", "#4a9e3a"];
const lights = ["#7fc23c", "#9fd23f", "#bfe24a", "#d7ea62"];

const round = (n: number) => Math.round(n * 10) / 10;

function seeded(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = seeded(20260902);
const branches: Branch[] = [];
const clusters: LeafCluster[] = [];
const MAX_LEVEL = 4;

function leafPath(s: number) {
  return `M0 ${-8 * s} C ${5 * s} ${-6 * s} ${6 * s} ${2 * s} 0 ${8 * s} C ${-6 * s} ${2 * s} ${-5 * s} ${-6 * s} 0 ${-8 * s} Z`;
}

function makeCluster(x: number, y: number, r: number, level: number, delay: number): LeafCluster {
  const leaves: Leaf[] = [];
  const put = (
    count: number,
    palette: string[],
    spread: number,
    size: [number, number],
    dx: number,
    dy: number,
  ) => {
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * r * spread;
      leaves.push({
        x: round(x + Math.cos(a) * d + dx),
        y: round(y + Math.sin(a) * d * 0.85 + dy),
        s: round(size[0] + rand() * (size[1] - size[0])),
        rot: round(rand() * 360),
        fill: palette[Math.floor(rand() * palette.length)],
      });
    }
  };
  put(9, shadow, 1.05, [1.5, 2.3], 4, 8);
  put(11, mids, 0.95, [1.3, 2.1], 0, 0);
  put(8, lights, 0.75, [1.0, 1.7], -5, -7);
  return { x, y, r, level, delay, leaves };
}

type Pt = [number, number];

function branchShape(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  w0: number,
  w1: number,
  flare: boolean,
) {
  const steps = 12;
  const left: Pt[] = [];
  const right: Pt[] = [];
  const lanes: Record<string, Pt[]> = { a: [], b: [], hi: [] };
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t ** 2 * x1;
    const py = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t ** 2 * y1;
    const tx = 2 * (1 - t) * (cx - x0) + 2 * t * (x1 - cx);
    const ty = 2 * (1 - t) * (cy - y0) + 2 * t * (y1 - cy);
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;
    const wobble = 1 + (rand() - 0.5) * 0.14;
    let hw = ((w0 + (w1 - w0) * t) / 2) * wobble;
    if (flare) hw *= 1 + 1.1 * (1 - t) ** 7;
    left.push([round(px + nx * hw), round(py + ny * hw)]);
    right.push([round(px - nx * hw), round(py - ny * hw)]);
    lanes.a.push([round(px + nx * hw * 0.35), round(py + ny * hw * 0.35)]);
    lanes.b.push([round(px - nx * hw * 0.25), round(py - ny * hw * 0.25)]);
    lanes.hi.push([round(px + nx * hw * 0.68), round(py + ny * hw * 0.68)]);
  }
  const poly = `M${left.map((p) => p.join(" ")).join(" L ")} L ${[...right]
    .reverse()
    .map((p) => p.join(" "))
    .join(" L ")} Z`;
  const line = (pts: Pt[]) => `M${pts.map((p) => p.join(" ")).join(" L ")}`;
  return { poly, grain: [line(lanes.a), line(lanes.b)], highlight: line(lanes.hi) };
}

function grow(x: number, y: number, angle: number, len: number, width: number, level: number, delay: number) {
  const ex = x + Math.cos(angle) * len;
  const ey = y + Math.sin(angle) * len;
  const mx = (x + ex) / 2;
  const my = (y + ey) / 2;
  const bend = (rand() - 0.5) * len * 0.55;
  const cx = mx + Math.cos(angle + Math.PI / 2) * bend;
  const cy = my + Math.sin(angle + Math.PI / 2) * bend;
  const w1 = width * 0.68;
  const shape = branchShape(x, y, cx, cy, ex, ey, width, w1, level === 0);
  branches.push({
    d: shape.poly,
    grain: shape.grain,
    highlight: shape.highlight,
    level,
    delay: round(delay),
    x0: round(x),
    y0: round(y),
    x: round(ex),
    y: round(ey),
  });

  if (level >= 2) {
    const r = level === 2 ? 48 : level === 3 ? 40 : 32;
    clusters.push(makeCluster(round(ex), round(ey), r, level, round(delay + 0.45)));
    if (level >= 3) {
      clusters.push(
        makeCluster(
          round(mx + (cx - mx) * 0.5),
          round(my + (cy - my) * 0.5),
          r * 0.7,
          level,
          round(delay + 0.3),
        ),
      );
    }
  }
  if (level === MAX_LEVEL) return;

  const kids = level === 0 ? 3 : 2 + (rand() < 0.6 ? 1 : 0);
  for (let i = 0; i < kids; i++) {
    const side = kids === 1 ? 0 : (i / (kids - 1)) * 2 - 1;
    const spread = level === 0 ? 0.55 : 0.5;
    const na = angle + side * spread * (0.7 + rand() * 0.6) + (rand() - 0.5) * 0.25;
    const clamped = Math.max(-Math.PI * 0.95, Math.min(-Math.PI * 0.05, na));
    grow(
      ex,
      ey,
      clamped,
      len * (0.62 + rand() * 0.14),
      w1 * (0.8 + rand() * 0.18),
      level + 1,
      delay + 0.42 + rand() * 0.12,
    );
  }
}

grow(330, 950, -Math.PI / 2, 300, 84, 0, 0);

const fruit = clusters
  .filter((c, i) => c.level >= 3 && i % 4 === 1)
  .slice(0, 12)
  .map((c, i) => ({
    x: round(c.x + (i % 2 ? 12 : -10)),
    y: round(c.y + 14),
    r: 9 + (i % 3) * 1.5,
    drops: i % 2 === 0,
  }));

const burstTips = clusters.filter((_, i) => i % 6 === 1).slice(0, 10);
const trunkTop = branches[0];

export function Tree({ plants, claimId, startDelay = 0 }: Props) {
  const reduce = useReducedMotion();
  const pulse = plants.length;

  return (
    <svg viewBox="0 0 660 960" className="h-full w-auto" aria-hidden="true" style={{ overflow: "visible" }}>
      <defs>
        <linearGradient id="bark" gradientUnits="userSpaceOnUse" x1="200" y1="0" x2="480" y2="0">
          <stop offset="0" stopColor="#4d3826" />
          <stop offset="0.3" stopColor="#2f2115" />
          <stop offset="0.7" stopColor="#1c120a" />
          <stop offset="1" stopColor="#262116" />
        </linearGradient>
        <filter id="barkTex" x="-10%" y="-5%" width="120%" height="110%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.09 0.005"
            numOctaves="4"
            seed="11"
            result="streaks"
          />
          <feDiffuseLighting in="streaks" lightingColor="#ffffff" surfaceScale="4.5" result="lit">
            <feDistantLight azimuth="200" elevation="42" />
          </feDiffuseLighting>
          <feComponentTransfer in="lit" result="lift">
            <feFuncR type="linear" slope="0.9" intercept="0.05" />
            <feFuncG type="linear" slope="0.9" intercept="0.05" />
            <feFuncB type="linear" slope="0.9" intercept="0.05" />
          </feComponentTransfer>
          <feComposite in="lift" in2="SourceAlpha" operator="in" result="clip" />
          <feBlend in="SourceGraphic" in2="clip" mode="multiply" result="tex" />
          <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="4" result="edge" />
          <feDisplacementMap in="tex" in2="edge" scale="5" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <radialGradient id="fruitGrad" cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#ffe27a" />
          <stop offset="1" stopColor="#e8801a" />
        </radialGradient>
        <radialGradient id="blossomGrad" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#fff7fb" />
          <stop offset="1" stopColor="#ffb7d3" />
        </radialGradient>
      </defs>

      <ellipse cx="340" cy="948" rx="230" ry="24" fill="#0f2f16" opacity="0.4" />

      <motion.g
        key={`pulse-${pulse}`}
        style={{ transformBox: "view-box", transformOrigin: `${trunkTop.x}px ${trunkTop.y}px` }}
        animate={
          reduce || pulse === 0 ? {} : { rotate: [0, -2, 1.6, -0.8, 0], scale: [1, 1.04, 0.99, 1.01, 1] }
        }
        transition={{ duration: 1.5, ease: "easeOut" }}
      >
        <g filter="url(#barkTex)">
          <g fill="url(#bark)">
            {branches.map((b, i) => (
              <path
                key={i}
                d={b.d}
                className="tree-grow"
                style={{ transformOrigin: `${b.x0}px ${b.y0}px`, animationDelay: `${startDelay + b.delay}s` }}
              />
            ))}
          </g>
          <g fill="url(#bark)">
            <path d="M 236 950 C 262 942 280 926 292 904 L 314 950 Z" />
            <path d="M 440 952 C 416 944 398 926 386 900 L 356 950 Z" />
            <path d="M 300 952 C 306 936 312 928 322 922 L 336 950 Z" />
          </g>
          <g fill="none" strokeLinecap="round">
            {branches
              .filter((b) => b.level <= 2)
              .map((b, i) => (
                <motion.g
                  key={i}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: startDelay + b.delay + 0.4, duration: 0.4 }}
                >
                  {b.grain.map((g, k) => (
                    <path
                      key={k}
                      d={g}
                      stroke="#150c06"
                      strokeWidth={b.level === 0 ? 3 : 1.6}
                      opacity={0.5}
                    />
                  ))}
                  <path
                    d={b.highlight}
                    stroke="#a3835c"
                    strokeWidth={b.level === 0 ? 2.6 : 1.4}
                    opacity={0.35}
                  />
                </motion.g>
              ))}
          </g>
          <g fill="#1a100a" opacity="0.55">
            <ellipse cx="322" cy="800" rx="7" ry="11" />
            <ellipse cx="345" cy="690" rx="5" ry="8" />
          </g>
          <g fill="#4b5a2a" opacity="0.35">
            <ellipse cx="300" cy="930" rx="30" ry="14" />
            <ellipse cx="368" cy="936" rx="24" ry="10" />
          </g>
        </g>

        <motion.g
          style={{ transformBox: "view-box", transformOrigin: `${trunkTop.x}px ${trunkTop.y}px` }}
          animate={reduce ? {} : { rotate: [-0.45, 0.45, -0.45] }}
          transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
        >
          {clusters.map((c, i) => (
            <motion.g
              key={i}
              initial={reduce ? undefined : { scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: startDelay + c.delay, type: "spring", stiffness: 140, damping: 13 }}
            >
              {c.leaves.map((l, k) => (
                <path
                  key={k}
                  d={leafPath(l.s)}
                  fill={l.fill}
                  transform={`translate(${l.x} ${l.y}) rotate(${l.rot})`}
                />
              ))}
            </motion.g>
          ))}

          {fruit.map((f, i) => (
            <motion.g
              key={`${i}-${claimId}`}
              initial={reduce ? undefined : { scale: 0 }}
              animate={
                claimId > 0 && f.drops && !reduce
                  ? { y: [0, 700], opacity: [1, 1, 0], scale: 1, rotate: [0, 50] }
                  : { scale: 1 }
              }
              transition={
                claimId > 0 && f.drops
                  ? { duration: 1.2, ease: [0.5, 0, 1, 1], delay: i * 0.12 }
                  : { delay: startDelay + 1.6 + i * 0.06, type: "spring", stiffness: 220, damping: 11 }
              }
            >
              <circle cx={f.x + 1} cy={f.y + 3} r={f.r} fill="#3b1a05" opacity={0.35} />
              <circle cx={f.x} cy={f.y} r={f.r} fill="url(#fruitGrad)" />
              <circle
                cx={f.x - f.r * 0.35}
                cy={f.y - f.r * 0.35}
                r={f.r * 0.28}
                fill="#fff6cf"
                opacity={0.9}
              />
            </motion.g>
          ))}

          <AnimatePresence>
            {plants.map((id, round) =>
              burstTips.map((c, i) => {
                const x = c.x + ((round * 7 + i * 3) % 24) - 12;
                const y = c.y - 10 - ((round * 5 + i * 2) % 16);
                return (
                  <motion.g
                    key={`${id}-${i}`}
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ delay: 0.25 + i * 0.07, type: "spring", stiffness: 260, damping: 12 }}
                  >
                    {[0, 72, 144, 216, 288].map((deg) => (
                      <ellipse
                        key={deg}
                        cx={x}
                        cy={y - 8}
                        rx={4.5}
                        ry={8}
                        fill="url(#blossomGrad)"
                        transform={`rotate(${deg} ${x} ${y})`}
                      />
                    ))}
                    <circle cx={x} cy={y} r={3} fill="#ffd75e" />
                    {[0, 1, 2].map((k) => (
                      <path
                        key={k}
                        d={leafPath(1.6)}
                        fill={lights[(i + k) % lights.length]}
                        transform={`translate(${x + (k - 1) * 14} ${y + 10}) rotate(${(k - 1) * 40})`}
                      />
                    ))}
                  </motion.g>
                );
              }),
            )}
          </AnimatePresence>
        </motion.g>
      </motion.g>
    </svg>
  );
}
