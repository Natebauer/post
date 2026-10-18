/** Fade out the start-up splash (index.html) once Post has something to show. */
export function hideSplash() {
  const el = document.getElementById("splash");
  if (!el || el.classList.contains("gone")) return;
  el.classList.add("gone");
  window.setTimeout(() => el.remove(), 320);
}
