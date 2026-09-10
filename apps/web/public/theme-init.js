try {
  const savedTheme = localStorage.getItem("agentfleet.theme");
  const themeColors = { cyber: "#070c17", daylight: "#f2f6fb", midnight: "#111018", forest: "#0d1813", eyecare: "#e8e5cf" };
  if (Object.hasOwn(themeColors, savedTheme)) {
    document.documentElement.dataset.theme = savedTheme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColors[savedTheme]);
  }
} catch { /* The application applies the default theme when storage is unavailable. */ }
