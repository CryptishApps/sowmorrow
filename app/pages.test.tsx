import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ErrorPage from "./error";
import GlobalError from "./global-error";
import NotFound from "./not-found";

vi.mock("@/components/hero-backdrop", () => ({ HeroBackdrop: () => null }));
vi.mock("next/font/google", () => ({
  Fraunces: () => ({ variable: "font-fraunces" }),
  Nunito: () => ({ variable: "font-nunito" }),
}));
vi.mock("./globals.css", () => ({}));

describe("not-found page", () => {
  it("names the missing page and links home", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { name: "Nothing planted here." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the meadow" })).toHaveAttribute("href", "/");
  });
});

describe("error boundary page", () => {
  it("shows the digest and retries on request", async () => {
    const retry = vi.fn();
    render(<ErrorPage error={Object.assign(new Error("boom"), { digest: "d1g3st" })} retry={retry} />);
    expect(screen.getByText("Reference d1g3st")).toBeInTheDocument();
    expect(screen.getByText(/No wallet action was submitted/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("renders without a digest", () => {
    render(<ErrorPage error={new Error("boom")} retry={() => undefined} />);
    expect(screen.queryByText(/Reference/)).toBeNull();
  });
});

describe("global error page", () => {
  it("renders its own document with a retry action", async () => {
    const retry = vi.fn();
    const { container } = render(
      <GlobalError error={Object.assign(new Error("boom"), { digest: "g1" })} retry={retry} />,
    );
    expect(container.textContent).toContain("The garden needs a moment.");
    expect(container.textContent).toContain("Reference g1");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
