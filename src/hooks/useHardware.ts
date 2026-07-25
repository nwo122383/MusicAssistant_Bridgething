import { useEffect, useRef } from "react";

interface HardwareHandlers {
  dialLeft: () => void;
  dialRight: () => void;
  dialPress: () => void;
  presetPress: (slot: number) => void;
  presetLongPress: (slot: number) => void;
  back: () => void;
  settings: () => void;
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

function hasKeyboardModifier(event: KeyboardEvent): boolean {
  return event.shiftKey || event.ctrlKey || event.altKey || event.metaKey;
}

function presetSlotFromKeyboardEvent(event: KeyboardEvent): number | undefined {
  const codeMatch = /^(?:Digit|Numpad)([1-4])$/.exec(event.code) ?? /^F([1-4])$/.exec(event.code);
  if (codeMatch) return Number(codeMatch[1]);
  const keyMatch = /^([1-4])$/.exec(event.key) ?? /^F([1-4])$/i.exec(event.key);
  return keyMatch ? Number(keyMatch[1]) : undefined;
}

export function useHardware(handlers: HardwareHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  const presetKeyboardEnabled =
    import.meta.env.VITE_CARTHING_HARDWARE === "true" ||
    import.meta.env.MODE === "bridgething" ||
    new URLSearchParams(window.location.search).get("hardware") === "carthing";

  useEffect(() => {
    const held = new Map<string, number>();
    const longPressed = new Set<string>();

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaX || event.deltaY;
      if (delta < 0) latest.current.dialLeft();
      if (delta > 0) latest.current.dialRight();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEntryTarget(event.target) || hasKeyboardModifier(event)) return;
      const presetSlot = presetKeyboardEnabled ? presetSlotFromKeyboardEvent(event) : undefined;
      const holdKey = presetSlot ? `preset:${presetSlot}:${event.code || event.key}` : event.code;
      if (event.repeat || held.has(holdKey)) return;
      const handledCodes = presetKeyboardEnabled
        ? ["Enter", "Escape", "KeyM", "Digit1", "Digit2", "Digit3", "Digit4", "Numpad1", "Numpad2", "Numpad3", "Numpad4", "F1", "F2", "F3", "F4"]
        : ["Enter", "Escape", "KeyM"];
      if (handledCodes.includes(event.code) || presetSlot) {
        event.preventDefault();
      }
      if (presetSlot) {
        const timer = window.setTimeout(() => {
          longPressed.add(holdKey);
          latest.current.presetLongPress(presetSlot);
        }, 1_000);
        held.set(holdKey, timer);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const presetSlot = presetKeyboardEnabled ? presetSlotFromKeyboardEvent(event) : undefined;
      const holdKey = presetSlot ? `preset:${presetSlot}:${event.code || event.key}` : event.code;
      const timer = held.get(holdKey);
      if (timer) clearTimeout(timer);
      held.delete(holdKey);
      if (isTextEntryTarget(event.target) || hasKeyboardModifier(event)) return;
      if (presetSlot) {
        if (!longPressed.delete(holdKey)) latest.current.presetPress(presetSlot);
      } else if (event.code === "Enter") latest.current.dialPress();
      else if (event.code === "Escape") latest.current.back();
      else if (event.code === "KeyM") latest.current.settings();
    };

    document.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    return () => {
      document.removeEventListener("wheel", onWheel);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      held.forEach(clearTimeout);
    };
  }, [presetKeyboardEnabled]);
}
