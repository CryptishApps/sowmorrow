import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { stocks } from "@/lib/stocks";
import type { StockSymbol } from "@/lib/stocks";
import { StockRail } from "./stock-rail";

function ControlledRail() {
  const [selected, setSelected] = useState<StockSymbol>("AMZNc");
  return <StockRail selected={selected} onSelect={setSelected} />;
}

describe("StockRail", () => {
  it("renders the complete reviewed catalog without search", () => {
    render(<StockRail selected="AMZNc" onSelect={vi.fn()} />);
    expect(screen.getAllByRole("radio")).toHaveLength(13);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Amazon · AMZNc/i })).toBeChecked();
  });

  it("shows edge affordances only where more rail content remains", () => {
    render(<StockRail selected={stocks[0].symbol} onSelect={vi.fn()} />);
    const rail = screen.getByTestId("stock-rail");
    Object.defineProperties(rail, {
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 900 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });

    fireEvent.scroll(rail);
    expect(screen.queryByTestId("stock-fade-left")).not.toBeInTheDocument();
    expect(screen.getByTestId("stock-fade-right")).toBeInTheDocument();

    Object.defineProperty(rail, "scrollLeft", { configurable: true, value: 300 });
    fireEvent.scroll(rail);
    expect(screen.getByTestId("stock-fade-left")).toBeInTheDocument();
    expect(screen.getByTestId("stock-fade-right")).toBeInTheDocument();

    Object.defineProperty(rail, "scrollLeft", { configurable: true, value: 600 });
    fireEvent.scroll(rail);
    expect(screen.getByTestId("stock-fade-left")).toBeInTheDocument();
    expect(screen.queryByTestId("stock-fade-right")).not.toBeInTheDocument();
  });

  it("uses a roving tab stop and supports radio-group arrow keys", async () => {
    const user = userEvent.setup();
    render(<ControlledRail />);
    const amazon = screen.getByRole("radio", { name: /Amazon · AMZNc/i });
    amazon.focus();

    await user.keyboard("{ArrowRight}");

    const coinbase = screen.getByRole("radio", { name: /Coinbase · COINc/i });
    expect(coinbase).toBeChecked();
    expect(coinbase).toHaveFocus();
    expect(coinbase).toHaveAttribute("tabindex", "0");
    expect(amazon).toHaveAttribute("tabindex", "-1");
  });
});

function overflowing(rail: HTMLElement, scrollLeft = 300) {
  Object.defineProperties(rail, {
    clientWidth: { configurable: true, value: 300 },
    scrollWidth: { configurable: true, value: 900 },
    scrollLeft: { configurable: true, writable: true, value: scrollLeft },
    setPointerCapture: { configurable: true, value: vi.fn() },
    releasePointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: () => true },
    scrollBy: { configurable: true, value: vi.fn() },
  });
  fireEvent.scroll(rail);
  return rail;
}

describe("StockRail overflow controls", () => {
  it("scrolls the rail with both edge arrows", () => {
    render(<StockRail selected={stocks[0].symbol} onSelect={vi.fn()} />);
    const rail = overflowing(screen.getByTestId("stock-rail"));

    fireEvent.click(screen.getByRole("button", { name: "Show later stocks" }));
    fireEvent.click(screen.getByRole("button", { name: "Show earlier stocks" }));

    expect(rail.scrollBy).toHaveBeenCalledTimes(2);
    expect((rail.scrollBy as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].left).toBeGreaterThan(0);
    expect((rail.scrollBy as unknown as ReturnType<typeof vi.fn>).mock.calls[1][0].left).toBeLessThan(0);
  });

  it("drags with the mouse and suppresses the click that would change the selection", () => {
    const onSelect = vi.fn();
    render(<StockRail selected={stocks[0].symbol} onSelect={onSelect} />);
    const rail = overflowing(screen.getByTestId("stock-rail"));

    fireEvent.pointerDown(rail, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 400 });
    fireEvent.pointerMove(rail, { pointerId: 1, clientX: 300 });
    fireEvent.pointerUp(rail, { pointerId: 1, clientX: 300 });

    expect(rail.scrollLeft).toBe(400);
    fireEvent.click(screen.getByRole("radio", { name: /Amazon · AMZNc/i }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps a click that never moved the rail", () => {
    const onSelect = vi.fn();
    render(<StockRail selected={stocks[0].symbol} onSelect={onSelect} />);
    const rail = overflowing(screen.getByTestId("stock-rail"));

    fireEvent.pointerDown(rail, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 400 });
    fireEvent.pointerUp(rail, { pointerId: 1, clientX: 400 });
    fireEvent.click(screen.getByRole("radio", { name: /Amazon · AMZNc/i }));

    expect(onSelect).toHaveBeenCalledWith("AMZNc");
  });

  it("abandons a cancelled drag without suppressing later clicks", () => {
    const onSelect = vi.fn();
    render(<StockRail selected={stocks[0].symbol} onSelect={onSelect} />);
    const rail = overflowing(screen.getByTestId("stock-rail"));

    fireEvent.pointerDown(rail, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 400 });
    fireEvent.pointerMove(rail, { pointerId: 1, clientX: 300 });
    fireEvent.pointerCancel(rail, { pointerId: 1 });
    fireEvent.click(screen.getByRole("radio", { name: /Amazon · AMZNc/i }));

    expect(onSelect).toHaveBeenCalledWith("AMZNc");
  });

  it("ignores touch and secondary-button pointers", () => {
    render(<StockRail selected={stocks[0].symbol} onSelect={vi.fn()} />);
    const rail = overflowing(screen.getByTestId("stock-rail"));

    fireEvent.pointerDown(rail, { pointerId: 2, pointerType: "touch", button: 0, clientX: 400 });
    fireEvent.pointerMove(rail, { pointerId: 2, clientX: 200 });
    expect(rail.scrollLeft).toBe(300);
  });

  it("abandons a press that leaves the rail before dragging", () => {
    render(<StockRail selected={stocks[0].symbol} onSelect={vi.fn()} />);
    const rail = overflowing(screen.getByTestId("stock-rail"));
    fireEvent.pointerDown(rail, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 400 });
    fireEvent.pointerLeave(rail, { pointerId: 1 });
    fireEvent.pointerMove(rail, { pointerId: 1, clientX: 200 });
    expect(rail.scrollLeft).toBe(300);
  });
});

describe("StockRail availability", () => {
  it("names unavailable stocks but never lets them be selected", () => {
    render(
      <StockRail
        selected="AAPLc"
        onSelect={vi.fn()}
        availableSymbols={new Set<StockSymbol>(["AAPLc", "TSLAc"])}
      />,
    );

    expect(screen.getByRole("radio", { name: /Amazon · AMZNc/i })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Tesla · TSLAc/i })).toBeEnabled();
    expect(screen.getAllByText("Unavailable on this test network")).toHaveLength(11);
  });

  it("moves Home and End across only the enabled stocks", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <StockRail
        selected="AAPLc"
        onSelect={onSelect}
        availableSymbols={new Set<StockSymbol>(["AAPLc", "TSLAc"])}
      />,
    );

    const apple = screen.getByRole("radio", { name: /Apple · AAPLc/i });
    apple.focus();
    await user.keyboard("{End}");
    expect(onSelect).toHaveBeenLastCalledWith("TSLAc");

    await user.keyboard("{Home}");
    expect(onSelect).toHaveBeenLastCalledWith("AAPLc");
  });

  it("wraps arrow selection around the enabled stocks", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <StockRail
        selected="AAPLc"
        onSelect={onSelect}
        availableSymbols={new Set<StockSymbol>(["AAPLc", "TSLAc"])}
      />,
    );

    screen.getByRole("radio", { name: /Apple · AAPLc/i }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(onSelect).toHaveBeenLastCalledWith("TSLAc");
  });

  it("disables every packet while a review is pending", () => {
    render(<StockRail selected="AAPLc" onSelect={vi.fn()} disabled />);
    for (const option of screen.getAllByRole("radio")) expect(option).toBeDisabled();
  });
});
