import { Fragment } from "react";
import { useStore } from "../store";
import { highlightRegex, searchTerms } from "../hooks";

/** Render text with the current search terms marked. */
export function Highlight({ text }: { text: string }) {
  const q = useStore((s) => s.search?.query);
  const re = highlightRegex(searchTerms(q));
  if (!re || !text) return <>{text}</>;
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}

/** Wrap matches of the search terms in <mark> inside a DOM subtree (used for HTML emails). */
export function highlightDom(root: HTMLElement, q: string | null | undefined) {
  const re = highlightRegex(searchTerms(q));
  if (!re) return;
  const doc = root.ownerDocument;
  // A non-global copy for testing (global regexes keep lastIndex between test() calls).
  const test = new RegExp(re.source, "i");
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement && !["SCRIPT", "STYLE", "MARK", "TITLE"].includes(n.parentElement.tagName) && test.test(n.nodeValue ?? "")
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const frag = doc.createDocumentFragment();
    const parts = (node.nodeValue ?? "").split(re);
    parts.forEach((p, i) => {
      if (i % 2 === 1) {
        const m = doc.createElement("mark");
        m.textContent = p;
        m.style.cssText = "background:rgba(245,197,66,.45);color:inherit;border-radius:2px";
        frag.appendChild(m);
      } else if (p) frag.appendChild(doc.createTextNode(p));
    });
    node.replaceWith(frag);
  }
}
