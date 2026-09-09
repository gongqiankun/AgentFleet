import { beforeEach } from "vitest";
import { setLocale } from "./index";
// Existing fixtures assert the Chinese interface; language-specific tests switch explicitly.
beforeEach(() => setLocale("zh-CN"));
