import { t } from "../i18n";
import { useEffect, useRef, useState, type ClipboardEvent } from "react";

export const MAX_IMAGES = 4;
const MAX_BYTES = 128 * 1024;
export const isInlineImage = (value: unknown): value is string => typeof value === "string" && value.length <= 175_000
  && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(t("图片读取失败，请重新复制截图"))); reader.readAsDataURL(blob); });
}
/** Clipboard rasters are re-encoded to remove metadata and bound transport size. */
export async function prepareClipboardImage(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error(t("请粘贴 PNG、JPEG 或 WebP 图片；不支持网页 HTML 或 SVG"));
  if (file.size > 20 * 1024 * 1024) throw new Error(t("原图超过 20 MB，请截取需要分析的区域后粘贴"));
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url; await image.decode();
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error(t("图片尺寸过大，请截取需要分析的区域"));
    let scale = Math.min(1, 2560 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    for (let attempt = 0; attempt < 7; attempt++) {
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d"); if (!context) throw new Error(t("浏览器无法处理截图，请更新浏览器后重试"));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const [type, quality] of [["image/png", 1], ["image/webp", .88], ["image/webp", .7]] as const) {
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
        if (blob && blob.size <= MAX_BYTES) return dataUrl(blob);
      }
      scale *= .75;
    }
    throw new Error(t("图片仍然过大，请截取关键区域后重新粘贴"));
  } finally { URL.revokeObjectURL(url); }
}

export function useImageDraft(owner: string, session?: string) {
  const key = session ? `agentfleet.images:${encodeURIComponent(owner)}:${encodeURIComponent(session)}` : "";
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0); const active = useRef(key); active.current = key;
  const pending = useRef(false);
  useEffect(() => { generation.current++; pending.current = false; setProcessing(false); setError(""); return () => { generation.current++; }; }, [key]);
  let stored: string[] = [];
  try { const value: unknown = key ? JSON.parse(localStorage.getItem(key) ?? "[]") : []; if (Array.isArray(value)) stored = value.filter(isInlineImage).slice(0, MAX_IMAGES); } catch { /* Drafts still work without storage. */ }
  const images = drafts[key] ?? stored;
  function save(next: string[]) {
    if (!key) return;
    setDrafts(current => ({ ...current, [key]: next }));
    try { if (next.length) localStorage.setItem(key, JSON.stringify(next)); else localStorage.removeItem(key); }
    catch { setError(t("浏览器存储空间不足：图片暂存在此页面，发送前请不要刷新")); }
  }
  async function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items).filter(item => item.kind === "file" && item.type.startsWith("image/")).map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (!files.length) return; // Normal text paste remains native.
    event.preventDefault();
    if (pending.current) { setError(t("正在处理上一张图片，请稍候再粘贴")); return; }
    if (images.length + files.length > MAX_IMAGES) { setError(t("一条消息最多 4 张图片，请先移除多余图片")); return; }
    const current = generation.current; pending.current = true; setProcessing(true); setError("");
    try {
      const next: string[] = [];
      for (const file of files) next.push(await prepareClipboardImage(file));
      if (generation.current === current && active.current === key) save([...images, ...next]);
    } catch (reason) { if (generation.current === current) setError(reason instanceof Error ? reason.message : t("图片处理失败，请重新粘贴")); }
    finally { if (generation.current === current) { pending.current = false; setProcessing(false); } }
  }
  return { images, processing, error, onPaste, remove: (index: number) => save(images.filter((_, i) => i !== index)), clear: () => save([]) };
}
