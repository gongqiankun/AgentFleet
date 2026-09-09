import { t, localized } from "../i18n";
export type PermissionProfile = "project" | "network" | "full";
export type PermissionScope = "machine" | "project" | "session";
export interface PermissionPreferences {
  preferences: Record<PermissionScope, { profile: PermissionProfile | null; revision: number }>;
  source: PermissionScope | "default";
  profile: PermissionProfile;
  supported: boolean;
}
export const permissionNames: Record<PermissionProfile, string> = localized(() => ({ project: t("项目内开发"), network: t("联网开发"), full: t("主机完整访问") }));
export const permissionSources: Record<string, string> = localized(() => ({ machine: t("主机默认"), project: t("项目设置"), session: t("此会话设置"), default: t("系统默认") }));
