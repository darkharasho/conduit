import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProfileMatchEditor } from "./ProfileMatchEditor";
import { parseConfigToml } from "../lib/config-model";

vi.mock("../lib/client", () => ({
  listWindows: vi.fn(async () => [
    { process: "firefox", class: "org.mozilla.firefox", title: "Home" },
  ]),
}));

describe("ProfileMatchEditor", () => {
  it("shows current match and applies edits", () => {
    const model = parseConfigToml('[profile.game]\nmatch = { class = "steam" }');
    const onApply = vi.fn();
    render(<ProfileMatchEditor model={model} profileName="game" onApply={onApply} />);
    const classInput = screen.getByLabelText("class") as HTMLInputElement;
    expect(classInput.value).toBe("steam");
    fireEvent.change(classInput, { target: { value: "steam_app_1" } });
    fireEvent.click(screen.getByText("Apply match"));
    expect(onApply).toHaveBeenCalledWith({ class: "steam_app_1" });
  });

  it("picker fills fields from a running window", async () => {
    const model = parseConfigToml('[profile.game.keys]\na = "b"');
    render(<ProfileMatchEditor model={model} profileName="game" onApply={() => {}} />);
    fireEvent.click(screen.getByText("Pick from open windows"));
    const item = await screen.findByText("org.mozilla.firefox");
    fireEvent.click(item);
    expect((screen.getByLabelText("class") as HTMLInputElement).value).toBe(
      "org.mozilla.firefox"
    );
    expect((screen.getByLabelText("process") as HTMLInputElement).value).toBe("firefox");
  });

  it("hides itself for the default profile", () => {
    const model = parseConfigToml('[profile.default.keys]\na = "b"');
    const { container } = render(
      <ProfileMatchEditor model={model} profileName="default" onApply={() => {}} />
    );
    expect(container.innerHTML).toBe("");
  });
});
