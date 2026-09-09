import { t } from "../i18n";
import { useRef, useState } from "react";
import { X } from "lucide-react";
import { isInlineImage } from "../lib/image-drafts";

export function MessageImages({ images, onRemove, disabled }: { images: string[]; onRemove?: (index: number) => void; disabled?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<string>();
  return <>
    <div className="message-images" aria-label={onRemove ? t("待发送图片") : t("消息图片")}>{images.filter(isInlineImage).map((url, index) => <div className="message-image" key={`${index}:${url.slice(-32)}`}>
      <button type="button" aria-label={t("查看图片 {0}", index + 1)} onClick={() => { setPreview(url); dialog.current?.showModal(); }}><img src={url} alt={t("图片 {0}", index + 1)} loading="lazy" /></button>
      {onRemove && <button type="button" className="message-image-remove" aria-label={t("移除图片 {0}", index + 1)} disabled={disabled} onClick={() => onRemove(index)}><X size={13} /></button>}
    </div>)}</div>
    <dialog className="image-lightbox" ref={dialog} aria-label={t("图片预览")} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }} onClose={() => setPreview(undefined)}>
      <button type="button" className="button" aria-label={t("关闭图片预览")} onClick={() => dialog.current?.close()}><X size={18} /></button>
      {preview && <img src={preview} alt={t("图片放大预览")} />}
    </dialog>
  </>;
}
