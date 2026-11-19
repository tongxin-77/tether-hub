// 贴图预处理：上传前在浏览器里缩放 / 重编码，减小手机照片体积、转换 HEIC 等格式（app.js 的 sendImage 使用）。
// 普通脚本（非模块），顶层声明与 app.js 共享；fitSize / pickOutput 为纯函数，测试在 Node 中用 vm 载入本文件。
'use strict';

const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMG = 10 * 1024 * 1024;
const IMG_EDGE = 2000; // 长边上限：Claude 会把图缩到约 1568px，更大没有意义
const KEEP_PNG = 2 * 1024 * 1024; // 未缩放且不超过此大小的 PNG 原样上传，保持截图文字清晰

/** 长边超过 max 时等比缩小 */
function fitSize(w, h, max) {
  const k = max / Math.max(w, h);
  if (k >= 1) return { w, h, scaled: false };
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: true };
}

/** 输出类型；空串表示原样上传 */
function pickOutput(type, hasAlpha, scaled, size) {
  if (type === 'image/gif') return ''; // 可能是动图，不重编码
  if (type === 'image/png' && !scaled && size <= KEEP_PNG) return '';
  return hasAlpha && (type === 'image/png' || type === 'image/webp') ? 'image/png' : 'image/jpeg';
}

function hasAlpha(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

function canvasBlob(cv, type) {
  if (cv.convertToBlob) return cv.convertToBlob({ type, quality: 0.85 });
  return new Promise((ok, fail) => cv.toBlob((b) => (b ? ok(b) : fail(new Error('编码失败'))), type, 0.85));
}

/** 解码（按 EXIF 方向）→ 必要时缩放 / 重编码；失败时原图合规则回退原图，否则抛出「不支持的图片格式」 */
async function prepareImage(blob) {
  const ok = IMG_TYPES.includes(blob.type);
  if (blob.type === 'image/gif') return blob;
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
    const { w, h, scaled } = fitSize(bmp.width, bmp.height, IMG_EDGE);
    if (ok && !pickOutput(blob.type, false, scaled, blob.size)) return blob;
    let cv;
    if (typeof OffscreenCanvas === 'function') cv = new OffscreenCanvas(w, h);
    else {
      cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
    }
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    const alpha = (blob.type === 'image/png' || blob.type === 'image/webp') && hasAlpha(ctx, w, h);
    const out = await canvasBlob(cv, pickOutput(blob.type, alpha, scaled, blob.size));
    return ok && !scaled && out.size >= blob.size ? blob : out; // 重编码反而更大时用原图
  } catch {
    if (ok) return blob;
    throw new Error('不支持的图片格式');
  } finally {
    if (bmp) bmp.close();
  }
}
