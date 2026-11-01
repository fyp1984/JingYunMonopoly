/**
 * dom.js —— 极简 DOM 工具（零依赖）
 */

/** 建元素：h("div", { class, style, dataset, onclick, ... }, ...子节点) */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") {
      // 注意：自定义属性（--x）用 Object.assign(el.style, ...) 赋值无效，必须 setProperty
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === null || sv === undefined) continue;
        if (sk.startsWith("--")) el.style.setProperty(sk, String(sv));
        else el.style[sk] = sv;
      }
    }
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(9)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function clear(el) { el.replaceChildren(); return el; }

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等价 Python f"{n:,}"（与内核同一实现，日志/金额展示口径统一）。 */
export { num } from "../core/engine.js";
