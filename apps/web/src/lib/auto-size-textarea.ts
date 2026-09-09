import { useLayoutEffect, type RefObject } from "react";

/** Re-measure on text, session and width changes; never replace the focused input. */
export function useAutoSizeTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string, context: string) {
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    const resize = () => {
      if (!input.clientWidth) return;
      const styles = getComputedStyle(input);
      const min = parseFloat(styles.minHeight) || 40;
      const max = parseFloat(styles.maxHeight) || 180;
      const scrollTop = input.scrollTop;
      input.style.height = "0px";
      const height = Math.max(min, Math.min(input.scrollHeight, max));
      input.style.height = `${height}px`;
      input.style.overflowY = input.scrollHeight > height ? "auto" : "hidden";
      input.scrollTop = scrollTop;
    };
    resize();
    let width = input.clientWidth;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      if (input.clientWidth !== width) { width = input.clientWidth; resize(); }
    });
    observer?.observe(input);
    window.addEventListener("resize", resize);
    return () => { observer?.disconnect(); window.removeEventListener("resize", resize); };
  }, [ref, value, context]);
}
