// Match the React default before the first paint, without overwriting saved choices.
const themeColors = { cyber: "#101923", daylight: "#f5f5f7", midnight: "#161618", forest: "#0d1813", eyecare: "#e8e5cf" };
let initialTheme = "daylight";
try {
  const saved = localStorage.getItem("agentfleet.theme");
  if (Object.hasOwn(themeColors, saved)) initialTheme = saved;
} catch { /* The default also works when browser storage is unavailable. */ }
document.documentElement.dataset.theme = initialTheme;
document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColors[initialTheme]);
