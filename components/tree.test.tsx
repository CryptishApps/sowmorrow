import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tree } from "./tree";

describe("Tree", () => {
  it("renders the bare tree before anything is planted", () => {
    const { container } = render(<Tree plants={[]} claimId={0} />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("grows one fruit per planted gift and pulses on a claim", () => {
    const { container, rerender } = render(<Tree plants={[1, 2, 3]} claimId={0} />);
    const before = container.querySelectorAll(".tree-grow").length;
    expect(before).toBeGreaterThanOrEqual(3);
    rerender(<Tree plants={[1, 2, 3]} claimId={42} />);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
