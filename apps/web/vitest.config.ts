import config from "./vite.config";
export default { ...config, test: { setupFiles: ["./src/i18n/test-setup.ts"] } };
