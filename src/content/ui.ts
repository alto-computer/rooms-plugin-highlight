/*
 * The highlight card and the note badges, after Hi-Lighter's card. Everything lives in one closed
 * shadow root on an element appended to <html>, outside <body>, so the document's serialization
 * and styles stay its own. The DOM is built node by node: no innerHTML, which a Trusted Types
 * policy in the document would refuse.
 */
import { COLORS, ORDER, type Annotation, type Color, type Highlight } from "../model";

export interface CardActions {
  recolor(id: string, color: Color): void;
  remove(id: string): void;
  addNote(id: string, body: string): void;
  editNote(id: string, noteId: string, body: string): void;
  removeNote(id: string, noteId: string): void;
}

export interface Badge {
  id: string;
  count: number;
  /** The last line box of the highlight, in viewport coordinates. */
  rect: DOMRect;
}

export interface Ui {
  /** Whether an event came from inside the card or the badges. */
  owns(e: Event): boolean;
  openCard(h: Highlight, rect: DOMRect, focusNote?: boolean): void;
  /** Re-renders the open card from the record; closes it when its highlight is gone. */
  update(highlights: readonly Highlight[]): void;
  closeCard(): void;
  readonly openId: string | null;
  setBadges(badges: Badge[]): void;
}

const QUOTE_MAX = 140;

const CSS_TEXT = `
:host{all:initial}
.layer{position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647}
.card{position:absolute;width:326px;max-width:92vw;border-radius:17px;overflow:hidden;
font:13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;letter-spacing:-.01em;
color:#2c2a26;background:#fbfaf7;border:.5px solid rgba(50,42,28,.12);
box-shadow:0 .5px 0 rgba(255,255,255,.7) inset,0 10px 34px rgba(40,34,22,.16),0 1px 3px rgba(40,34,22,.08)}
.head{display:flex;align-items:center;gap:6px;padding:11px 12px 10px;border-bottom:.5px solid rgba(50,42,28,.1)}
.dots{display:flex;gap:7px;flex:1}
.dot{width:17px;height:17px;border-radius:999px;border:none;cursor:pointer;padding:0;box-shadow:0 0 0 .5px rgba(40,34,22,.16)}
.dot[aria-pressed=true]{box-shadow:0 0 0 2px rgba(251,250,247,.95),0 0 0 3.5px rgba(44,40,34,.6)}
.icon{border:none;background:transparent;cursor:pointer;width:26px;height:26px;border-radius:999px;padding:0;
display:inline-flex;align-items:center;justify-content:center;color:rgba(60,55,47,.55)}
.icon:hover{background:rgba(50,42,28,.07);color:#2c2a26}
.quote{margin:12px;padding:9px 11px;border-radius:11px;font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.notes{max-height:230px;overflow-y:auto;padding:0 12px}
.empty{color:rgba(60,55,47,.4);font-size:12.5px;padding:2px 0 10px}
.note{padding:10px 0;border-top:.5px solid rgba(50,42,28,.08)}
.note:first-child{border-top:none}
.body{white-space:pre-wrap;word-break:break-word}
.meta{color:rgba(60,55,47,.42);font-size:10.5px;margin-top:4px}
.tools{display:flex;gap:2px;margin-top:5px}
.btn{border:none;background:transparent;color:rgba(60,55,47,.6);font:inherit;font-size:11.5px;cursor:pointer;padding:3px 7px;border-radius:7px}
.btn:hover{background:rgba(50,42,28,.07);color:#2c2a26}
.add{display:flex;gap:8px;align-items:flex-end;padding:11px 12px 12px;border-top:.5px solid rgba(50,42,28,.1)}
textarea{flex:1;resize:vertical;min-height:36px;font-family:inherit;font-size:13px;line-height:1.45;border:.5px solid rgba(50,42,28,.16);
border-radius:10px;padding:8px 10px;color:#2c2a26;background:rgba(255,255,255,.66)}
textarea:focus{outline:none;border-color:#2c2a26;box-shadow:0 0 0 3px rgba(44,40,34,.14)}
.primary{border:none;background:#2c2a26;color:#fdfbf7;cursor:pointer;border-radius:10px;padding:9px 15px;font-family:inherit;font-size:12.5px;font-weight:590;line-height:1}
.badge{position:absolute;min-width:13px;height:13px;padding:0 3px;border-radius:999px;pointer-events:none;
font:600 9px/13px -apple-system,system-ui,sans-serif;text-align:center;color:#fdfbf7;background:rgba(60,55,47,.7)}
@media (prefers-color-scheme:dark){
.card{color:#f0eee9;background:#282521;border-color:rgba(255,255,255,.12)}
.head,.add{border-color:rgba(255,255,255,.1)}
.note{border-color:rgba(255,255,255,.08)}
.icon,.btn{color:rgba(240,238,233,.6)}
.icon:hover,.btn:hover{background:rgba(255,255,255,.1);color:#fff}
.meta,.empty{color:rgba(240,238,233,.4)}
textarea{background:rgba(0,0,0,.25);color:#f0eee9;border-color:rgba(255,255,255,.16)}
.primary{background:#ece8e0;color:#2c2a26}
}`;

const ICONS = {
  trash: ["M3 6h18", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6", "M10 11v6", "M14 11v6"],
  close: ["M18 6 6 18", "m6 6 12 12"],
};

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function icon(doc: Document, paths: string[]): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round" })) svg.setAttribute(k, v);
  for (const d of paths) {
    const p = doc.createElementNS(ns, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
};

export function mountUi(doc: Document, actions: CardActions): Ui {
  const host = doc.createElement("rooms-highlight-ui");
  host.style.setProperty("all", "initial", "important");
  const root = host.attachShadow({ mode: "closed" });
  if (Array.isArray(root.adoptedStyleSheets)) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS_TEXT);
    root.adoptedStyleSheets = [sheet];
  } else {
    root.append(el(doc, "style", "", CSS_TEXT));
  }
  const layer = el(doc, "div", "layer");
  const badges = el(doc, "div", "badges");
  const card = el(doc, "div", "card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Highlight");
  card.hidden = true;
  layer.append(badges, card);
  root.append(layer);
  doc.documentElement.append(host);

  let open: { h: Highlight; rect: DOMRect } | null = null;

  const place = (rect: DOMRect) => {
    const view = doc.defaultView!;
    const w = card.offsetWidth || 326;
    const h = card.offsetHeight || 200;
    const below = rect.bottom + 8;
    const top = below + h > view.innerHeight && rect.top - 8 - h > 0 ? rect.top - 8 - h : below;
    const left = Math.max(4, Math.min(rect.left, doc.documentElement.clientWidth - w - 4));
    card.style.top = `${view.scrollY + top}px`;
    card.style.left = `${view.scrollX + left}px`;
  };

  const noteRow = (h: Highlight, a: Annotation) => {
    const row = el(doc, "div", "note");
    const tools = el(doc, "div", "tools");
    const edit = el(doc, "button", "btn", "Edit");
    const del = el(doc, "button", "btn", "Delete");
    edit.addEventListener("click", () => {
      const ta = el(doc, "textarea", "");
      ta.value = a.body;
      ta.rows = 2;
      ta.setAttribute("aria-label", "Edit note");
      const save = el(doc, "button", "primary", "Save");
      const commit = () => actions.editNote(h.id, a.id, ta.value);
      save.addEventListener("click", commit);
      ta.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      });
      row.replaceChildren(ta, save);
      ta.focus();
    });
    del.addEventListener("click", () => actions.removeNote(h.id, a.id));
    tools.append(edit, del);
    row.append(el(doc, "div", "body", a.body), el(doc, "div", "meta", fmtTime(a.updatedAt)), tools);
    return row;
  };

  const render = (h: Highlight, rect: DOMRect, focusNote: boolean) => {
    const head = el(doc, "div", "head");
    const dots = el(doc, "div", "dots");
    for (const c of ORDER) {
      const d = el(doc, "button", "dot");
      d.title = COLORS[c].label;
      d.setAttribute("aria-label", COLORS[c].label);
      d.setAttribute("aria-pressed", String(h.color === c));
      d.style.background = COLORS[c].solid;
      d.addEventListener("click", () => actions.recolor(h.id, c));
      dots.append(d);
    }
    const del = el(doc, "button", "icon");
    del.title = "Delete highlight";
    del.setAttribute("aria-label", "Delete highlight");
    del.append(icon(doc, ICONS.trash));
    del.addEventListener("click", () => actions.remove(h.id));
    const close = el(doc, "button", "icon");
    close.title = "Close";
    close.setAttribute("aria-label", "Close");
    close.append(icon(doc, ICONS.close));
    close.addEventListener("click", () => ui.closeCard());
    head.append(dots, del, close);

    const quote = el(doc, "div", "quote", h.text.length > QUOTE_MAX ? `${h.text.slice(0, QUOTE_MAX)}…` : h.text);
    quote.style.background = COLORS[h.color].bg;

    const notes = el(doc, "div", "notes");
    if (h.annotations.length) notes.append(...h.annotations.map((a) => noteRow(h, a)));
    else notes.append(el(doc, "div", "empty", "No notes yet"));

    const add = el(doc, "div", "add");
    const ta = el(doc, "textarea", "");
    ta.rows = 2;
    ta.placeholder = "Add a note… (⌘Enter)";
    ta.setAttribute("aria-label", "Add a note");
    const addBtn = el(doc, "button", "primary", "Add");
    const commit = () => {
      if (ta.value.trim()) actions.addNote(h.id, ta.value);
    };
    addBtn.addEventListener("click", commit);
    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        commit();
      }
    });
    add.append(ta, addBtn);

    card.replaceChildren(head, quote, notes, add);
    card.dataset.id = h.id;
    card.hidden = false;
    open = { h, rect };
    place(rect);
    if (focusNote) ta.focus();
  };

  const ui: Ui = {
    owns: (e) => e.composedPath().includes(host),
    openCard: (h, rect, focusNote = false) => render(h, rect, focusNote),
    update(highlights) {
      if (!open) return;
      const h = highlights.find((x) => x.id === open!.h.id);
      if (!h) ui.closeCard();
      else if (h !== open.h) render(h, open.rect, false);
    },
    closeCard() {
      open = null;
      card.hidden = true;
      card.replaceChildren();
    },
    get openId() {
      return open?.h.id ?? null;
    },
    setBadges(list) {
      const view = doc.defaultView!;
      badges.replaceChildren(
        ...list.map((b) => {
          const s = el(doc, "span", "badge", String(b.count));
          s.dataset.id = b.id;
          s.style.left = `${view.scrollX + b.rect.right + 2}px`;
          s.style.top = `${view.scrollY + b.rect.top - 4}px`;
          return s;
        }),
      );
    },
  };
  return ui;
}
