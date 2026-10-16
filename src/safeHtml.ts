/**
 * Making email HTML safe to show.
 *
 * Mail is untrusted, so it's parsed in an inert document (DOMParser never runs scripts or loads
 * anything) and rebuilt from what's allowed. Two uses:
 *   - sanitizeHtml: for HTML shown inside Post's own window (quoted text in the composer, a
 *     scheduled message's preview). Strict: no styles, no forms, no active content at all.
 *   - prepareEmail: for a whole email shown in its sandboxed frame. Keeps the email's own styles,
 *     but still drops anything active, and can hold back remote images (tracking pixels).
 */

const DROP = new Set([
  "script", "iframe", "frame", "frameset", "object", "embed", "applet", "link", "meta", "base", "form", "input",
  "button", "textarea", "select", "option", "template", "noscript", "svg", "math", "portal", "audio", "video",
  "source", "track", "param", "dialog",
]);
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "background", "poster", "cite", "longdesc", "xlink:href", "srcset", "data"]);
const SAFE_URL = /^(https?:|mailto:|tel:|cid:|#|data:image\/(png|jpe?g|gif|webp);|http:\/\/postatt\.localhost|postatt:)/i;

function cleanUrl(v: string): string | null {
  const s = v.replace(/[\u0000- ]+/g, "");
  if (!s) return null;
  // Relative links have no meaning in an email; keep only schemes known to be inert.
  return SAFE_URL.test(s) ? v.trim() : null;
}

function cleanTree(root: ParentNode, keepStyles: boolean) {
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag) || (!keepStyles && tag === "style")) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc" || name === "formaction" || name === "http-equiv") {
        el.removeAttribute(attr.name);
      } else if (URL_ATTRS.has(name)) {
        if (name === "srcset") {
          const ok = attr.value.split(",").every((part) => cleanUrl(part.trim().split(/\s+/)[0] ?? ""));
          if (!ok) el.removeAttribute(attr.name);
        } else if (cleanUrl(attr.value) === null) el.removeAttribute(attr.name);
      } else if (name === "style") {
        if (!keepStyles && /url\s*\(|expression\s*\(|behavior\s*:|-moz-binding/i.test(attr.value)) el.removeAttribute(attr.name);
        else if (/expression\s*\(|behavior\s*:|-moz-binding|javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
      }
    }
  }
}

/** Strict cleanup for HTML shown in Post's own window. */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  cleanTree(doc.body, false);
  return doc.body.innerHTML;
}

// Remote means fetched from the web (and so able to tell the sender you opened it). Post's own
// attachment and avatar addresses are local.
const isRemote = (v: string) => /^\s*(https?:)?\/\//i.test(v) && !/^\s*https?:\/\/(postatt|avatar)\.localhost/i.test(v);

/**
 * A whole email for its sandboxed frame: active content removed, and with `blockRemote`, remote
 * images held back (removed until the reader asks to show them). Returns the body HTML,
 * the email's own <style> blocks, and how many remote images were held back.
 */
export function prepareEmail(html: string, blockRemote: boolean): { body: string; styles: string; blocked: number } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  cleanTree(doc, true);
  let blocked = 0;
  if (blockRemote) {
    for (const img of Array.from(doc.querySelectorAll<HTMLImageElement>("img"))) {
      const src = img.getAttribute("src") ?? "";
      if (isRemote(src)) {
        img.setAttribute("data-post-src", src);
        img.removeAttribute("src");
        blocked++;
      }
      if (img.hasAttribute("srcset")) {
        img.setAttribute("data-post-srcset", img.getAttribute("srcset")!);
        img.removeAttribute("srcset");
      }
    }
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[background]"))) {
      if (isRemote(el.getAttribute("background") ?? "")) {
        el.setAttribute("data-post-background", el.getAttribute("background")!);
        el.removeAttribute("background");
        blocked++;
      }
    }
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[style*='url']"))) {
      const style = el.getAttribute("style") ?? "";
      if (/url\(\s*['"]?\s*(https?:)?\/\//i.test(style)) {
        el.setAttribute("data-post-style", style);
        el.setAttribute("style", style.replace(/url\(\s*['"]?\s*(https?:)?\/\/[^)]*\)/gi, "none"));
        blocked++;
      }
    }
  }
  const styles = Array.from(doc.querySelectorAll("style"))
    .map((s) => {
      const css = s.textContent ?? "";
      s.remove();
      return blockRemote ? css.replace(/url\(\s*['"]?\s*(https?:)?\/\/[^)]*\)/gi, "none") : css;
    })
    .join("\n");
  return { body: doc.body.innerHTML, styles, blocked };
}
