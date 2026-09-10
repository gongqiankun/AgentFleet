try {
  const savedTheme = localStorage.getItem("agentfleet.theme");
  if (["cyber", "daylight", "midnight", "forest"].includes(savedTheme)) {
    document.documentElement.dataset.theme = savedTheme;
  }
} catch { /* The application applies the default theme when storage is unavailable. */ }
