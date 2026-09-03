export function SproutMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <defs>
        <linearGradient id="seedGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffd75e" />
          <stop offset="1" stopColor="#f29a1c" />
        </linearGradient>
        <linearGradient id="leafGrad" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#3d8a3a" />
          <stop offset="1" stopColor="#9ad24f" />
        </linearGradient>
      </defs>
      <ellipse cx="24" cy="38" rx="9" ry="6.5" fill="url(#seedGrad)" />
      <path
        d="M24 38 C 24 30 24 24 24 16"
        stroke="#3d8a3a"
        strokeWidth="2.6"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M24 24 C 14 24 8 18 8 9 C 17 9 24 14 24 24 Z" fill="url(#leafGrad)" />
      <path d="M24 18 C 24 11 31 5 40 5 C 40 14 33 19 24 18 Z" fill="url(#leafGrad)" />
    </svg>
  );
}

export function Logo() {
  return (
    <div className="flex items-center gap-2 text-cloud">
      <SproutMark size={34} />
      <span className="text-shadow-sky text-[24px] font-bold leading-none tracking-[-0.01em]">sowmorrow</span>
    </div>
  );
}
