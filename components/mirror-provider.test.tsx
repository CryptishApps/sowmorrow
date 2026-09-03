import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mirrorApi, mirrorConfigured } from "@/lib/convex/api";
import { MirrorProvider, useMirrorMutation, useMirrorQuery } from "@/lib/convex/provider";

function Probe() {
  const gifts = useMirrorQuery(mirrorApi.freshness, { chainId: 8453 });
  const attach = useMirrorMutation(mirrorApi.attachNote);
  return (
    <div>
      <p data-testid="state">{`${gifts.configured}:${gifts.connected}:${String(gifts.data)}:${String(gifts.error)}`}</p>
      <button
        type="button"
        onClick={() =>
          void attach({ chainId: 8453, vault: "0x", giftId: "1", note: "x" }).catch((caught: Error) => {
            document.title = caught.message;
          })
        }
      >
        attach
      </button>
    </div>
  );
}

describe("mirror wiring without NEXT_PUBLIC_CONVEX_URL", () => {
  it("reports the mirror as unconfigured instead of throwing", () => {
    expect(mirrorConfigured).toBe(false);
    render(
      <MirrorProvider>
        <Probe />
      </MirrorProvider>,
    );

    expect(screen.getByTestId("state")).toHaveTextContent("false:false:undefined:null");
  });

  it("still renders its children so the page is never blank", () => {
    render(
      <MirrorProvider>
        <p>chain only</p>
      </MirrorProvider>,
    );
    expect(screen.getByText("chain only")).toBeInTheDocument();
  });

  it("refuses a mutation rather than pretending it was written", async () => {
    render(
      <MirrorProvider>
        <Probe />
      </MirrorProvider>,
    );
    screen.getByRole("button", { name: "attach" }).click();
    await Promise.resolve();
    expect(document.title).toBe("The Sowmorrow mirror is not configured");
  });
});
