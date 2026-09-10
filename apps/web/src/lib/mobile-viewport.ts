import { useEffect } from "react";

/** Follow the visible viewport when a mobile keyboard resizes or pans Safari. */
export function useMobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const root = document.documentElement;
        // Do not fight pinch zoom. Layout should retain its unzoomed dimensions.
        if (viewport.scale !== 1) return;
        root.style.setProperty("--visible-height", `${viewport.height}px`);
        root.style.setProperty("--visible-top", `${viewport.offsetTop}px`);
        root.toggleAttribute("data-keyboard-open", window.innerHeight - viewport.height > 120);
      });
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--visible-height");
      document.documentElement.style.removeProperty("--visible-top");
      document.documentElement.removeAttribute("data-keyboard-open");
    };
  }, []);
}
