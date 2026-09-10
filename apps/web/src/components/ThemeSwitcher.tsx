import { Check, SunMoon } from "lucide-react";
import { t } from "../i18n";
import { setTheme, useTheme, type Theme } from "../lib/theme";

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const selected = useTheme();
  return (
    <label className="theme-switcher">
      <SunMoon size={15} aria-hidden="true" />
      <select aria-label={t("界面主题")} value={selected} onChange={event => setTheme(event.target.value as Theme)}>
        <option value="cyber">{compact ? t("赛博") : t("赛博朋克")}</option>
        <option value="daylight">{t("日光")}</option>
        <option value="midnight">{t("午夜")}</option>
        <option value="forest">{t("森林")}</option>
      </select>
    </label>
  );
}

const themeOptions: { value: Theme; label: string; description: string }[] = [
  { value: "cyber", label: "赛博朋克", description: "深蓝网格、霓虹信号与切角控件" },
  { value: "daylight", label: "日光", description: "明亮画布、制图点阵与清晰边界" },
  { value: "midnight", label: "午夜", description: "柔和深色、薰衣草高亮与圆润表面" },
  { value: "forest", label: "森林", description: "深绿纹理、黄铜色与自然曲线" },
];

export function ThemeSettings() {
  const selected = useTheme();
  return (
    <div className="theme-options" role="radiogroup" aria-label={t("界面主题")}>
      {themeOptions.map(option => (
        <button
          className={`theme-option theme-option--${option.value}`}
          type="button"
          role="radio"
          aria-checked={selected === option.value}
          key={option.value}
          onClick={() => setTheme(option.value)}
        >
          <span className="theme-option__preview" aria-hidden="true"><i /><i /><i /></span>
          <span className="theme-option__copy"><strong>{t(option.label)}</strong><small>{t(option.description)}</small></span>
          <span className="theme-option__check" aria-hidden="true">{selected === option.value && <Check size={14} />}</span>
        </button>
      ))}
    </div>
  );
}
