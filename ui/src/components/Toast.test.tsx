import { act, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Toast } from "./Toast";

describe("Toast", () => {
  it("renders message and fires the action", () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    render(
      <Toast
        toast={{ kind: "success", message: "Side button now does Copy", actionLabel: "Undo", onAction }}
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
      <Toast toast={{ kind: "success", message: "ok" }} onDismiss={onDismiss} />,
    );
    act(() => vi.advanceTimersByTime(6100));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    rerender(<Toast toast={{ kind: "error", message: "That didn't stick" }} onDismiss={onDismiss} />);
    act(() => vi.advanceTimersByTime(60000));
    expect(onDismiss).toHaveBeenCalledTimes(1); // errors never auto-dismiss
    vi.useRealTimers();
  });
});
