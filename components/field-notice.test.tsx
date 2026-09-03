import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FieldNotice, MeadowLink } from "./field-notice";

vi.mock("@/components/hero-backdrop", () => ({ HeroBackdrop: () => <div data-testid="backdrop" /> }));

describe("FieldNotice", () => {
  it("renders the code, title, body, optional detail, and action", () => {
    render(
      <FieldNotice
        code="404 · page not found"
        title="Nothing planted here."
        body="This path has not grown anything."
        detail="Reference abc123"
        action={<MeadowLink />}
      />,
    );
    expect(screen.getByRole("heading", { name: "Nothing planted here." })).toBeInTheDocument();
    expect(screen.getByText("404 · page not found")).toBeInTheDocument();
    expect(screen.getByText("Reference abc123")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the meadow" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Sowmorrow home" })).toHaveAttribute("href", "/");
    expect(screen.getByTestId("backdrop")).toBeInTheDocument();
  });

  it("omits the detail block when there is no detail", () => {
    render(<FieldNotice code="x" title="t" body="b" />);
    expect(screen.queryByText(/Reference/)).toBeNull();
  });
});
