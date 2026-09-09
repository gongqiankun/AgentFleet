import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Scroll ownership belongs to the reader until they return to the bottom. */
export function useFollowScroll(latestVersion: string) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const tracking = useRef(true);
  const initialized = useRef(false);
  const previousVersion = useRef(latestVersion);
  const previousTop = useRef(0);
  const anchor = useRef<{ node: HTMLElement; offset: number } | undefined>(undefined);
  const [following, setFollowing] = useState(true);
  const [hasNewContent, setHasNewContent] = useState(false);

  const rememberAnchor = useCallback(() => {
    const view = viewport.current;
    if (!view) return;
    const top = view.getBoundingClientRect().top;
    const node = Array.from(view.querySelectorAll<HTMLElement>("[data-scroll-anchor]")).find(item => item.getBoundingClientRect().bottom > top + 1);
    anchor.current = node ? { node, offset: node.getBoundingClientRect().top - top } : undefined;
    previousTop.current = view.scrollTop;
  }, []);
  const maintainPosition = useCallback(() => {
    const view = viewport.current;
    if (!view || !view.clientHeight) return;
    if (tracking.current) view.scrollTop = Math.max(0, view.scrollHeight - view.clientHeight);
    else if (anchor.current && view.contains(anchor.current.node)) {
      const delta = anchor.current.node.getBoundingClientRect().top - view.getBoundingClientRect().top - anchor.current.offset;
      if (Math.abs(delta) > 0.5) view.scrollTop += delta;
    }
    rememberAnchor();
  }, [rememberAnchor]);
  const jumpToLatest = useCallback(() => {
    tracking.current = true; setFollowing(true); setHasNewContent(false);
    maintainPosition();
  }, [maintainPosition]);
  const pause = useCallback(() => {
    tracking.current = false; setFollowing(false); rememberAnchor();
  }, [rememberAnchor]);
  const onScroll = useCallback(() => {
    const view = viewport.current;
    if (!view) return;
    const movedUp = view.scrollTop < previousTop.current - 1;
    const atBottom = view.scrollHeight - view.clientHeight - view.scrollTop <= 4;
    if (movedUp && !atBottom) { tracking.current = false; setFollowing(false); }
    else if (atBottom) { tracking.current = true; setFollowing(true); setHasNewContent(false); }
    rememberAnchor();
  }, [rememberAnchor]);

  // Runs after prepend/append commits, before paint. The old visible node is the
  // anchor, so simultaneous new output cannot distort a scrollHeight-based delta.
  useLayoutEffect(() => {
    if (initialized.current && latestVersion !== previousVersion.current && !tracking.current) setHasNewContent(true);
    previousVersion.current = latestVersion;
    maintainPosition();
    if (viewport.current?.clientHeight) initialized.current = true;
  });
  useLayoutEffect(() => {
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(maintainPosition);
    if (viewport.current) observer?.observe(viewport.current);
    if (content.current) observer?.observe(content.current);
    window.addEventListener("resize", maintainPosition);
    return () => { observer?.disconnect(); window.removeEventListener("resize", maintainPosition); };
  }, [maintainPosition]);

  return { viewport, content, following, hasNewContent, onScroll, pause, jumpToLatest };
}
