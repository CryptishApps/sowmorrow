import Link from "next/link";
import type { Metadata } from "next";
import { FieldNotice } from "@/components/field-notice";

export const metadata: Metadata = { title: "Nothing planted here — Sowmorrow" };

export default function NotFound() {
  return (
    <FieldNotice
      code="404 · page not found"
      title="Nothing planted here."
      body="This path has not grown anything. Every gift starts from the meadow on the homepage."
      action={
        <Link href="/" className="primary-button inline-flex items-center">
          Back to the meadow
        </Link>
      }
    />
  );
}
