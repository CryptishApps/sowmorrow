import Link from "next/link";

export default function GiftNotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-sky-deep px-6 text-center">
      <section className="w-full max-w-md rounded-[26px] bg-cream p-7 text-ink shadow-card">
        <span className="text-4xl" aria-hidden="true">
          🌱
        </span>
        <h1 className="display mt-3 text-3xl">No gift lives at that link.</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          A Sowmorrow gift link needs a known Base network, that network&rsquo;s reviewed vault address, and a
          whole gift number.
        </p>
        <Link href="/" className="primary-button mt-5 inline-block">
          Back to Sowmorrow
        </Link>
      </section>
    </main>
  );
}
