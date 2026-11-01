/**
 * store.js —— 键值持久化的统一入口
 *
 * Web 版：只用 localStorage（浏览器 / 本机调试）。
 * Android 外壳：localStorage 之外，**额外镜像一份**到 App 私有目录（见 MainActivity 的
 *   JYMNative 桥）。WebView 的 localStorage 在清数据 / 换包时可能丢，私有目录里的
 *   副本是兜底；读的时候 localStorage 优先，取不到再回落到原生副本。
 *
 * 原生桥不存在时（Web 版、或旧外壳）自动降级，全部走 localStorage —— 不抛错。
 */

/** 取原生桥（不存在返回 null）。 */
function nativeBridge() {
  try {
    return (typeof window !== "undefined" && window.JYMNative) ? window.JYMNative : null;
  } catch { return null; }
}

/** 把异常都吞掉：存储失败绝不能让游戏卡住。 */
function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

export function getItem(key) {
  const local = safe(() => localStorage.getItem(key), null);
  if (local !== null && local !== undefined) return local;
  const b = nativeBridge();
  if (!b) return null;
  const mirrored = safe(() => b.read(key), null);
  return (mirrored === undefined || mirrored === null || mirrored === "") ? null : mirrored;
}

export function setItem(key, value) {
  safe(() => localStorage.setItem(key, String(value)));
  const b = nativeBridge();
  if (b) safe(() => b.write(key, String(value)));
}

export function removeItem(key) {
  safe(() => localStorage.removeItem(key));
  const b = nativeBridge();
  if (b) safe(() => b.remove(key));
}

/** 是否挂上了原生镜像（供界面显示存储来源）。 */
export function hasNativeMirror() { return !!nativeBridge(); }
