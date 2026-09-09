import { t } from "../i18n";
import { ArrowDown } from "lucide-react";
import type { ReactNode } from "react";
import type { TimelineEvent } from "../lib/types";
import { useFollowScroll } from "../lib/follow-scroll";

export function ConversationViewport({ events, children }: { events: TimelineEvent[]; children: ReactNode }) {
  const last = events.at(-1);
  const scroll = useFollowScroll(JSON.stringify(last ? [last.id, last.body, last.command, last.output, last.diff, last.images, last.payloadState] : []));
  return <div className="conversation-viewport">
    <div className="timeline-scroll" ref={scroll.viewport} onScroll={scroll.onScroll} onWheelCapture={event => { if (event.deltaY < 0) scroll.pause(); }} role="region" aria-label={t("会话记录")} tabIndex={0}>
      <div ref={scroll.content}>{children}</div>
    </div>
    {!scroll.following && <button type="button" className="timeline-jump" onClick={scroll.jumpToLatest}><ArrowDown size={14} aria-hidden="true" />{scroll.hasNewContent ? t("新消息") : t("回到最新")}</button>}
  </div>;
}
