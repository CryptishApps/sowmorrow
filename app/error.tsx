"use client";

import { FieldNotice, MeadowLink } from "@/components/field-notice";

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <FieldNotice
      code="Something went wrong"
      title="A brief change in the weather."
      body="Sowmorrow could not finish loading this view. No wallet action was submitted, and nothing you planted has changed."
      detail={error.digest ? `Reference ${error.digest}` : undefined}
      action={
        <>
          <button type="button" onClick={() => retry()} className="primary-button">
            Try again
          </button>
          <MeadowLink />
        </>
      }
    />
  );
}
