import { Languages } from "lucide-react";
import { setLocale, useLocale, type Locale } from "../i18n";

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const language = useLocale();
  return <label className="language-switcher"><Languages size={15} aria-hidden="true" /><select aria-label="Language / 语言" value={language} onChange={event => setLocale(event.target.value as Locale)}><option value="zh-CN">{compact ? "中文" : "简体中文"}</option><option value="en">{compact ? "EN" : "English"}</option></select></label>;
}
