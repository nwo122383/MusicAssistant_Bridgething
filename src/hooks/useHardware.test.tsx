import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHardware } from "./useHardware";

function Harness({
  presetLongPress = vi.fn(),
  presetPress,
}: {
  presetLongPress?: (slot: number) => void;
  presetPress: (slot: number) => void;
}) {
  useHardware({
    dialLeft: vi.fn(),
    dialRight: vi.fn(),
    dialPress: vi.fn(),
    presetPress,
    presetLongPress,
    back: vi.fn(),
    settings: vi.fn(),
  });
  return <input aria-label="Password" type="password" />;
}

describe("Car Thing hardware shortcuts", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    vi.useRealTimers();
  });

  it("does not intercept Shift+2 while entering a password", () => {
    const presetPress = vi.fn();
    const view = render(<Harness presetPress={presetPress} />);
    const input = view.getByLabelText("Password");

    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "Digit2", key: "@", shiftKey: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, code: "Digit2", key: "@", shiftKey: true }));

    expect(presetPress).not.toHaveBeenCalled();
  });

  it("does not handle PC number keys as presets", () => {
    const presetPress = vi.fn();
    render(<Harness presetPress={presetPress} />);

    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "Digit2", key: "2" }));
    document.body.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, code: "Digit2", key: "2" }));

    expect(presetPress).not.toHaveBeenCalled();
  });

  it("never treats modified number keys as presets", () => {
    const presetPress = vi.fn();
    render(<Harness presetPress={presetPress} />);

    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      code: "Digit2",
      key: "@",
      shiftKey: true,
    }));
    document.body.dispatchEvent(new KeyboardEvent("keyup", {
      bubbles: true,
      code: "Digit2",
      key: "@",
      shiftKey: true,
    }));

    expect(presetPress).not.toHaveBeenCalled();
  });

  it("handles Car Thing top buttons when hardware mode is enabled", () => {
    window.history.replaceState(null, "", "/?hardware=carthing");
    const presetPress = vi.fn();
    render(<Harness presetPress={presetPress} />);

    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "F3", key: "F3" }));
    document.body.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, code: "F3", key: "F3" }));

    expect(presetPress).toHaveBeenCalledWith(3);
  });

  it("long-presses Car Thing top buttons when hardware mode is enabled", () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/?hardware=carthing");
    const presetPress = vi.fn();
    const presetLongPress = vi.fn();
    render(<Harness presetPress={presetPress} presetLongPress={presetLongPress} />);

    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "Numpad4", key: "4" }));
    vi.advanceTimersByTime(1_100);
    document.body.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, code: "Numpad4", key: "4" }));

    expect(presetLongPress).toHaveBeenCalledWith(4);
    expect(presetPress).not.toHaveBeenCalled();
  });
});
