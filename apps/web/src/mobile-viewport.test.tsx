// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useMobileViewport } from "./lib/mobile-viewport";

const original = window.visualViewport;
afterEach(() => {
  cleanup();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: original });
  vi.restoreAllMocks();
});
function Viewport() { useMobileViewport(); return null; }
it("tracks keyboard resize and pan, leaves pinch zoom alone, and cleans up", async () => {
  const viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0, scale: 1 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  const { unmount } = render(<Viewport />);
  const root = document.documentElement;
  await waitFor(() => expect(root.style.getPropertyValue("--visible-height")).toBe(`${viewport.height}px`));
  act(() => { viewport.height = 360; viewport.offsetTop = 42; viewport.dispatchEvent(new Event("resize")); });
  await waitFor(() => expect(root.style.getPropertyValue("--visible-height")).toBe("360px"));
  expect(root.style.getPropertyValue("--visible-top")).toBe("42px");
  expect(root.hasAttribute("data-keyboard-open")).toBe(true);
  act(() => { viewport.scale = 2; viewport.height = 180; viewport.dispatchEvent(new Event("resize")); });
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(root.style.getPropertyValue("--visible-height")).toBe("360px");
  act(() => { viewport.scale = 1; viewport.height = window.innerHeight; viewport.offsetTop = 0; viewport.dispatchEvent(new Event("resize")); });
  await waitFor(() => expect(root.hasAttribute("data-keyboard-open")).toBe(false));
  unmount();
  expect(root.style.getPropertyValue("--visible-height")).toBe("");
});
