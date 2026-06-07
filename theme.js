(() => {
  const saved = localStorage.getItem("sideclip-theme");
  const preferred = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const dark = theme === "dark";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#10100f" : "#f4f1e8");
    const toggle = document.querySelector("#themeToggle");
    if (!toggle) return;
    toggle.setAttribute("aria-pressed", String(dark));
    toggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    toggle.querySelector(".theme-icon").textContent = dark ? "☀" : "☾";
    toggle.querySelector(".theme-label").textContent = dark ? "Light" : "Dark";
  }

  applyTheme(saved || preferred);

  addEventListener("DOMContentLoaded", () => {
    applyTheme(document.documentElement.dataset.theme);
    document.querySelector("#themeToggle")?.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      localStorage.setItem("sideclip-theme", next);
      applyTheme(next);
    });
  });
})();
