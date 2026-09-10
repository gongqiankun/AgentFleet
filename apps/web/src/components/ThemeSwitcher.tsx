import { Palette } from "lucide-react";
import { t } from "../i18n";
import { setTheme, useTheme, type Theme } from "../lib/theme";

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const selected = useTheme();
  return (
    <label className="theme-switcher">
      <Palette size={15} aria-hidden="true" />
      <select aria-label={t("界面主题")} value={selected} onChange={event => setTheme(event.target.value as Theme)}>
        <option value="cyber">{compact ? t("赛博") : t("赛博朋克")}</option>
        <option value="daylight">{t("日光")}</option>
        <option value="midnight">{t("午夜")}</option>
        <option value="forest">{t("森林")}</option>
      </select>
    </label>
  );
}
