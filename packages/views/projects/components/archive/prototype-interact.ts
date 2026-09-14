/**
 * 原型 HTML 预览互动：iframe 内 [data-fp] 点击 ↔ 父页高亮。
 *
 * 预览走 sandbox="allow-scripts"（无 allow-same-origin），不能读
 * contentDocument。postMessage 仍可用：iframe 点热点上报，父页回推选中 id。
 */

export const PROTOTYPE_FP_MESSAGE = "multica-prototype-fp";

export type PrototypeFpMessage = {
  type: typeof PROTOTYPE_FP_MESSAGE;
  id: string | null;
};

const INTERACT_SHIM = `<script>
(function(){
  var TYPE = ${JSON.stringify(PROTOTYPE_FP_MESSAGE)};
  var STYLE_ID = "multica-fp-interact";
  function ensureStyle(){
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = "[data-fp]{cursor:pointer;outline:1.5px dashed rgba(37,99,235,.32);outline-offset:2px;transition:outline-color .15s,box-shadow .15s}"
      + "[data-fp]:hover{outline-color:rgba(37,99,235,.72)}"
      + "[data-fp][data-multica-sel='1']{outline:2px solid rgb(37,99,235);box-shadow:0 0 0 4px rgba(37,99,235,.18);scroll-margin:32px}";
    (document.head || document.documentElement).appendChild(s);
  }
  function select(id){
    var nodes = document.querySelectorAll("[data-fp][data-multica-sel]");
    for (var i = 0; i < nodes.length; i++) nodes[i].removeAttribute("data-multica-sel");
    if (!id) return;
    var sel = "[data-fp=\\"" + (window.CSS && CSS.escape ? CSS.escape(id) : id) + "\\"]";
    var el = document.querySelector(sel);
    if (!el) return;
    el.setAttribute("data-multica-sel", "1");
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
  document.addEventListener("click", function(e){
    if (e.defaultPrevented) return;
    var t = e.target;
    if (!t || typeof t.closest !== "function") return;
    var el = t.closest("[data-fp]");
    if (!el) return;
    var id = el.getAttribute("data-fp");
    if (!id) return;
    e.preventDefault();
    select(id);
    parent.postMessage({ type: TYPE, id: id }, "*");
  });
  window.addEventListener("message", function(e){
    if (!e.data || e.data.type !== TYPE) return;
    select(e.data.id || null);
  });
  ensureStyle();
})();
</script>`;

export const __PROTOTYPE_INTERACT_SHIM__ = INTERACT_SHIM;

export function withPrototypeInteractShim(html: string | undefined): string {
  return (html ?? "") + INTERACT_SHIM;
}

export function readPrototypeFpId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const rec = data as Partial<PrototypeFpMessage>;
  if (rec.type !== PROTOTYPE_FP_MESSAGE) return null;
  if (rec.id == null) return null;
  const id = String(rec.id).trim();
  return id || null;
}

export function postPrototypeHighlight(
  target: Window | null | undefined,
  id: string | null,
): void {
  if (!target) return;
  const payload: PrototypeFpMessage = { type: PROTOTYPE_FP_MESSAGE, id };
  target.postMessage(payload, "*");
}

export function isPrototypeFpFrom(
  event: MessageEvent,
  source: Window | null | undefined,
): string | null {
  if (!source || event.source !== source) return null;
  return readPrototypeFpId(event.data);
}
