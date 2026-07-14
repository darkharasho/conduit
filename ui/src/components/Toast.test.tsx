import { act, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { Toast } from "./Toast";

afterEach(() => {
  vi.useRealTimers();
});

describe("Toast", () => {
  it("renders message and fires the action", () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    render(
      <Toast
        toast={{ id: 1, kind: "success", message: "Side button now does Copy", actionLabel: "Undo", onAction }}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Side button now does Copy");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onAction).toHaveBeenCalled();
  });

  it("auto-dismisses success after 6s but keeps errors", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <Toast toast={{ id: 1, kind: "success", message: "ok" }} onDismiss={onDismiss} />,
    );
    act(() => vi.advanceTimersByTime(6100));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    rerender(<Toast toast={{ id: 2, kind: "error", message: "That didn't stick" }} onDismiss={onDismiss} />);
    act(() => vi.advanceTimersByTime(60000));
    expect(onDismiss).toHaveBeenCalledTimes(1); // errors never auto-dismiss
    vi.useRealTimers();
  });
});

describe("phase 6 nits", () => {
  it("item 2: auto-dismiss timer does not reset on parent re-render (same toast.id)", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    // Render at t=0
    const { rerender } = render(
      <Toast toast={{ id: 1, kind: "success", message: "ok" }} onDismiss={onDismiss} />,
    );
    // Advance to 3s (timer started at 0s, fires at 6s)
    act(() => vi.advanceTimersByTime(3000));
    expect(onDismiss).not.toHaveBeenCalled();
    // Parent re-renders with a new onDismiss callback reference but same toast.id
    // (simulates parent re-render). If timer reset, it would now fire at 3+6=9s.
    const onDismiss2 = vi.fn();
    rerender(
      <Toast toast={{ id: 1, kind: "success", message: "ok" }} onDismiss={onDismiss2} />,
    );
    // Advance 3.5s more → total 6.5s. If timer NOT reset, original fires at 6s (already passed
    // at 6.5s total). If timer WAS reset, it would fire at 9.5s (not yet).
    act(() => vi.advanceTimersByTime(3500));
    // Exactly one dismiss call (from the original 6s timer)
    const totalDismissCalls = onDismiss.mock.calls.length + onDismiss2.mock.calls.length;
    expect(totalDismissCalls).toBe(1);
  });
});
