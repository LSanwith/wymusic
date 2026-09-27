/* ============================================================
 * 液态玻璃卡片（Liquid Glass Panel）
 *
 * 把 .block 卡片原来的「假毛玻璃」backdrop-filter: blur() 换成真实的
 * feDisplacementMap 背景折射 —— 与 liquid glass 组件同一套算法：
 *   一维剖面 calculateDisplacementMap()（斜面求导→法线→斯涅尔折射→积分位移）
 *   二维采样 → RG 位移贴图 → SVG 滤镜链 → backdrop-filter: url(#id)
 *
 * 与组件的唯一区别在二维采样：组件写死了「圆形」（按到圆心的距离取圆环带），
 * 这里换成「圆角矩形的有符号距离场」，法线取该点的内向法线，
 * 于是折射带沿着卡片的圆角边框走，而不是一圈内切椭圆。
 *
 * 重要：backdrop-filter 只作用于元素【背后】的内容，不影响元素自身的
 * 文字与子元素，所以卡片做成液态玻璃不会牺牲可读性。
 * ============================================================ */
(function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';

  var CFG = {
    bezel: 34,           // 折射带宽度上限（CSS px，沿卡片边框内侧）
    bezelRatio: 0.15,    // 折射带宽度 = 卡片高度 × 该比例（再受上面的上限约束）
    glassThickness: 130, // 玻璃厚度（影响剖面形状：越大越"厚"）
    refractPower: 3.2,   // 折射强度（组件默认 0.45，卡片需要更明显一些）
    chroma: 1.0,         // 边缘色散
    samples: 128,        // 一维剖面采样数
    mapMax: 480,         // 位移贴图最长边上限（越大越细腻，越费内存）
    tint: '#ffffff'      // 玻璃颜色（白 = 不染色）
  };

  /* ---------- 一维折射位移剖面（原样取自组件） ---------- */
  var CONVEX = function (x) { return Math.pow(1 - Math.pow(1 - x, 4), 1 / 4); };

  function calculateDisplacementMap(glassThickness, bezelWidth, bezelHeightFn, refractiveIndex, samples) {
    samples = samples || 128;
    var eta = 1 / refractiveIndex;
    function refract(nx, ny) {
      var dot = ny;
      var k = 1 - eta * eta * (1 - dot * dot);
      if (k < 0) return null;                       // 全反射
      var ks = Math.sqrt(k);
      return [-(eta * dot + ks) * nx, eta - (eta * dot + ks) * ny];
    }
    var out = new Array(samples);
    for (var i = 0; i < samples; i++) {
      var x = i / samples;
      var y = bezelHeightFn(x);
      var dx = x < 1 ? 0.0001 : -0.0001;
      var d = (bezelHeightFn(x + dx) - y) / dx;
      var mag = Math.sqrt(d * d + 1);
      var ref = refract(-d / mag, -1 / mag);
      out[i] = (!ref || Math.abs(ref[1]) < 1e-10) ? 0 : ref[0] * ((y * bezelWidth + glassThickness) / ref[1]);
    }
    return out;
  }

  /* ---------- 圆角矩形位移贴图 ----------
     dist : 到圆角矩形边界的距离（内部为正）
     no   : 该点的【外向】法线（在 |x|,|y| 对称空间里算，再按象限翻回去） */
  function sampleRoundedRectMap(profile, maxDisp, mapW, mapH, elemW, elemH, bezelPx, radius) {
    var rgba = new Uint8ClampedArray(mapW * mapH * 4);
    var scale = elemW / mapW;                       // 贴图像素 → CSS 像素
    var hx = mapW / 2, hy = mapH / 2;
    var r = Math.max(0, Math.min(radius / scale, Math.min(hx, hy)));
    var bx = hx - r, by = hy - r;                   // 圆角圆心（对称空间）
    var bezelMap = Math.max(1, bezelPx / scale);
    // 位移量按元素 CSS 像素归一化：feDisplacementMap 的 scale 作用于元素坐标，
    // 而贴图分辨率 ≠ 元素尺寸，所以必须乘 elemW/mapW（组件里是 size/rs），
    // 否则不同尺寸的卡片折射强度会不一致。
    var range = 127 * (elemW / mapW) * (1 / Math.max(maxDisp, 1)) * 0.98;
    var PL = profile.length - 1;

    var i = 0;
    for (var y = 0; y < mapH; y++) {
      var py = y + 0.5 - hy;
      var ay = Math.abs(py);
      var sy = py < 0 ? -1 : 1;
      for (var x = 0; x < mapW; x++, i += 4) {
        var px = x + 0.5 - hx;
        var ax = Math.abs(px);

        var dist, nox, noy;
        var ex = ax - bx, ey = ay - by;
        if (ex > 0 && ey > 0) {                     // 圆角区：法线指向圆心外
          var len = Math.sqrt(ex * ex + ey * ey);
          dist = r - len;
          nox = len > 1e-6 ? ex / len : 0;
          noy = len > 1e-6 ? ey / len : 0;
        } else if (ex > ey) {                       // 左右直边
          dist = bx + r - ax;
          nox = 1; noy = 0;
        } else {                                    // 上下直边
          dist = by + r - ay;
          nox = 0; noy = 1;
        }

        if (dist <= 0 || dist >= bezelMap) {        // 边界外 / 平坦区：零位移
          rgba[i] = 128; rgba[i + 1] = 128; rgba[i + 2] = 0; rgba[i + 3] = 255;
          continue;
        }
        // t = 1 贴边、0 折射带内侧 —— 与组件一致（写反的话边缘就没有折射了）
        var t = 1 - dist / bezelMap;
        var disp = profile[(t * PL) | 0] || 0;
        // 内向法线：对称空间的外向法线按象限翻回真实方向，再取反
        var sx = px < 0 ? -1 : 1;
        var inx = -(nox * sx), iny = -(noy * sy);
        rgba[i]     = 128 + inx * disp * range;     // R = X 位移
        rgba[i + 1] = 128 + iny * disp * range;     // G = Y 位移
        rgba[i + 2] = 0;
        rgba[i + 3] = 255;
      }
    }
    return rgba;
  }

  /* ---------- RGBA → PNG data URL ---------- */
  var _cv = null, _ctx = null;
  function mapToDataUrl(rgba, w, h) {
    if (!_cv) { _cv = document.createElement('canvas'); _ctx = _cv.getContext('2d'); }
    _cv.width = w; _cv.height = h;
    _ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
    return _cv.toDataURL('image/png');
  }

  function hexToRgb(hex) {
    var h = String(hex || '#ffffff').replace('#', '').trim();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n)) return { r: 255, g: 255, b: 255 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  /* ---------- SVG 滤镜链（与组件同构，末节点即滤镜输出） ---------- */
  var filterRoot = null;
  function buildFilter(id, w, h, radius) {
    var old = document.getElementById(id);
    if (old && old.parentNode && old.parentNode.parentNode) {
      filterRoot.removeChild(old.parentNode);
    }

    // 折射带宽度：卡片高度差异很大（132~340px），按高度取比例并夹在合理区间，
    // 否则矮卡片的上下两条折射带会互相吃掉、整张卡都变成斜面。
    var bezelW = Math.max(6, Math.min(CFG.bezel, h * CFG.bezelRatio, Math.min(w, h) / 2 - 1));
    var profile = calculateDisplacementMap(CFG.glassThickness, bezelW, CONVEX, 1.5, CFG.samples);
    var maxDisp = 0.1;
    for (var i = 0; i < profile.length; i++) {
      var a = Math.abs(profile[i]);
      if (a > maxDisp) maxDisp = a;
    }

    var scale = Math.min(1, CFG.mapMax / Math.max(w, h));
    var mapW = Math.max(8, Math.round(w * scale));
    var mapH = Math.max(8, Math.round(h * scale));
    var url = mapToDataUrl(
      sampleRoundedRectMap(profile, maxDisp, mapW, mapH, w, h, bezelW, radius),
      mapW, mapH
    );

    var base = Math.max(3, maxDisp * CFG.refractPower);
    var sR = base * (1 - 0.10 * CFG.chroma);
    var sG = base;
    var sB = base * (1 + 0.12 * CFG.chroma);

    var tint = hexToRgb(CFG.tint);
    var gR = 0.4 + 0.6 * (tint.r / 255), gG = 0.4 + 0.6 * (tint.g / 255), gB = 0.4 + 0.6 * (tint.b / 255);

    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');

    var filter = document.createElementNS(SVGNS, 'filter');
    filter.id = id;
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    filter.setAttribute('x', '0'); filter.setAttribute('y', '0');
    filter.setAttribute('width', '100%'); filter.setAttribute('height', '100%');
    filter.setAttribute('filterUnits', 'objectBoundingBox');
    filter.setAttribute('primitiveUnits', 'userSpaceOnUse');

    var im = document.createElementNS(SVGNS, 'feImage');
    im.setAttribute('href', url);
    im.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url);
    im.setAttribute('x', '0'); im.setAttribute('y', '0');
    im.setAttribute('width', String(w)); im.setAttribute('height', String(h));
    im.setAttribute('preserveAspectRatio', 'none');
    im.setAttribute('result', 'map');

    function mk(values, result) {
      var e = document.createElementNS(SVGNS, 'feColorMatrix');
      e.setAttribute('type', 'matrix');
      e.setAttribute('values', values);
      e.setAttribute('in', 'SourceGraphic');
      e.setAttribute('result', result);
      return e;
    }
    function disp(inRef, sc, result) {
      var e = document.createElementNS(SVGNS, 'feDisplacementMap');
      e.setAttribute('in', inRef); e.setAttribute('in2', 'map');
      e.setAttribute('scale', String(sc));
      e.setAttribute('xChannelSelector', 'R');
      e.setAttribute('yChannelSelector', 'G');
      e.setAttribute('result', result);
      return e;
    }
    function blend(a2, b2, result) {
      var e = document.createElementNS(SVGNS, 'feBlend');
      e.setAttribute('in', a2); e.setAttribute('in2', b2); e.setAttribute('mode', 'screen');
      if (result) e.setAttribute('result', result);
      return e;
    }

    filter.appendChild(im);
    filter.appendChild(mk('1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', 'chR'));
    filter.appendChild(mk('0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', 'chG'));
    filter.appendChild(mk('0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0', 'chB'));
    filter.appendChild(disp('chR', sR, 'dR'));
    filter.appendChild(disp('chG', sG, 'dG'));
    filter.appendChild(disp('chB', sB, 'dB'));
    filter.appendChild(blend('dR', 'dG', 'rg'));
    filter.appendChild(blend('rg', 'dB', 'refracted'));

    var tintNode = document.createElementNS(SVGNS, 'feColorMatrix');
    tintNode.setAttribute('type', 'matrix');
    tintNode.setAttribute('values',
      gR.toFixed(4) + ' 0 0 0 0  0 ' + gG.toFixed(4) + ' 0 0 0  0 0 ' + gB.toFixed(4) + ' 0 0  0 0 0 1 0');
    tintNode.setAttribute('in', 'refracted');
    filter.appendChild(tintNode);

    svg.appendChild(filter);
    filterRoot.appendChild(svg);
    return { id: id, mapW: mapW, mapH: mapH, bezel: bezelW, maxDisp: maxDisp, base: base };
  }

  /* ---------- 应用到卡片 ---------- */
  function radiusOf(el) {
    var r = parseFloat(getComputedStyle(el).borderTopLeftRadius);
    return isFinite(r) && r > 0 ? r : 0;
  }

  function apply() {
    if (!filterRoot) {
      filterRoot = document.createElement('div');
      filterRoot.setAttribute('aria-hidden', 'true');
      filterRoot.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none;';
      document.body.appendChild(filterRoot);
    }
    var panels = document.querySelectorAll('.block');
    for (var i = 0; i < panels.length; i++) {
      var el = panels[i];
      var w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
      if (w < 8 || h < 8) continue;
      var id = 'lgp-' + i + '-' + w + 'x' + h;
      if (el.dataset.lgPanel === id) continue;      // 尺寸没变就不重建
      try {
        buildFilter(id, w, h, radiusOf(el));
        el.style.backdropFilter = 'url(#' + id + ') blur(2px)';
        el.style.webkitBackdropFilter = 'url(#' + id + ') blur(2px)';
        el.dataset.lgPanel = id;
      } catch (e) {
        /* 生成失败就保留原有的普通毛玻璃，不影响页面 */
      }
    }
  }

  function ready() {
    apply();
    if (window.ResizeObserver) {
      var t = null;
      var ro = new ResizeObserver(function () {
        if (t) clearTimeout(t);
        t = setTimeout(apply, 180);
      });
      var panels = document.querySelectorAll('.block');
      for (var i = 0; i < panels.length; i++) ro.observe(panels[i]);
    } else {
      var t2 = null;
      window.addEventListener('resize', function () {
        if (t2) clearTimeout(t2);
        t2 = setTimeout(apply, 180);
      }, { passive: true });
    }
    window.liquidGlassPanel = { config: CFG, apply: apply, rebuild: function () {
      var p = document.querySelectorAll('.block');
      for (var i = 0; i < p.length; i++) delete p[i].dataset.lgPanel;
      apply();
    } };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
