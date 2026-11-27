/* ==========================================================================
   renderer.js —— 竖屏 180×320 低分辨率绘制，按设备像素整数倍放大后仍是硬像素
   ----------------------------------------------------------------------------
   画面全部使用纯色，不叠加半透明（半透明叠加正是像素画发「塑料」的常见原因）：
     · 天空：4 段纯色带，交界处用 4×4 Bayer 抖动过渡，只在启动时生成一次
     · 远景：淡紫色云（空气透视，无描边）、闪烁的星、孔明灯
     · 跑道：白色虚线分隔 + 底部云台
     · 角色 / 道具统一 2 倍像素，画布内文字统一 12px
   几何全部取自 PG.Layout。
   ========================================================================== */
(function (global) {
    'use strict';
    var PG = global.PG = global.PG || {};
    var C = PG.CONFIG, L = PG.Layout, S = PG.Sprites, P = S.PALETTE;
    var W = L.W, H = L.H;

    var INK = '#2e222f', INK2 = '#3e3546', INK3 = '#625565', PAPER = '#fdf3e0', WHITE = '#ffffff';

    /* ---------------------------------------------------------------- 静态天空 */
    var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    /* [起点 y, 终点 y, 起色, 终色]；起止同色为纯色带，否则线性抖动过渡 */
    var SEGS = [
        [0, 60, '#8fd3ff', '#8fd3ff'],
        [60, 84, '#8fd3ff', '#eaaded'],
        [84, 150, '#eaaded', '#eaaded'],
        [150, 176, '#eaaded', '#fca790'],
        [176, 250, '#fca790', '#fca790'],
        [250, 276, '#fca790', '#fdcbb0'],
        [276, 320, '#fdcbb0', '#fdcbb0']
    ];
    var sky = null;

    function rgb(hex) {
        return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    }

    function buildSky() {
        if (!global.document) return;
        sky = global.document.createElement('canvas');
        sky.width = W; sky.height = H;
        var c = sky.getContext('2d');
        if (!c || !c.createImageData) { sky = null; return; }
        var img = c.createImageData(W, H), d = img && img.data;
        if (!d) { sky = null; return; }
        for (var s = 0; s < SEGS.length; s++) {
            var seg = SEGS[s], c0 = rgb(seg[2]), c1 = rgb(seg[3]);
            for (var y = seg[0]; y < seg[1]; y++) {
                var t = seg[1] === seg[0] ? 0 : (y - seg[0] + 1) / (seg[1] - seg[0]);
                for (var x = 0; x < W; x++) {
                    var toC1 = c0 === c1 ? false : ((BAYER[((y >> 1) & 3) * 4 + ((x >> 1) & 3)] + 0.5) / 16) < t;
                    var col = toC1 ? c1 : c0, i = (y * W + x) * 4;
                    d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255;
                }
            }
        }
        c.putImageData(img, 0, 0);
    }
    buildSky();

    /* ---------------------------------------------------------------- 场景元素表 */
    var STARS = [], CLOUDS = [], LANTERNS = [], LINES = [];
    (function () {
        var i;
        for (i = 0; i < 16; i++) STARS.push({ x: ((i * 23 + 5) % 88) * 2, y: (16 + (i * 37) % 44) * 2, ph: i % 4 });
        CLOUDS.push({ x: 10, y: 70, s: 2, v: 5 });
        CLOUDS.push({ x: 96, y: 132, s: 3, v: 3 });
        CLOUDS.push({ x: 150, y: 196, s: 2, v: 4 });
        CLOUDS.push({ x: 40, y: 236, s: 2, v: 2 });
        LANTERNS.push({ x: 20, y: 108, ph: 0, v: 3 });
        LANTERNS.push({ x: 150, y: 170, ph: 2.1, v: 2 });
        for (i = 0; i < 10; i++) LINES.push({ x: ((i * 19 + 3) % 88) * 2, len: 12 + (i * 5) % 12, ph: i * 17 });
    })();
    var CLOUD_TINT = { o: '#cbb4e6', w: '#f6f1fb', W: '#e3d6f2' };
    var RIVAL_COLOR = { blue: P.b, pink: P.p, yellow: P.y };

    function fill(ctx, x, y, w, h, color) {
        ctx.fillStyle = color;
        ctx.fillRect(x, y, w, h);
    }

    function text(ctx, str, x, y, color, outline) {
        ctx.font = '12px "ZpixPixel", "Courier New", monospace';
        ctx.textBaseline = 'top';
        if (outline) {
            ctx.fillStyle = INK;
            ctx.fillText(str, x - 2, y); ctx.fillText(str, x + 2, y);
            ctx.fillText(str, x, y - 2); ctx.fillText(str, x, y + 2);
        }
        ctx.fillStyle = color || PAPER;
        ctx.fillText(str, x, y);
    }

    /* 让元素在 [ -margin, span + margin ) 内循环流动 */
    function flow(v, t, speed, span, margin) {
        var total = span + margin * 2;
        return ((v + t * speed) % total + total) % total - margin;
    }

    /* ---------------------------------------------------------------- 背景 */
    function drawBackdrop(ctx, t) {
        if (sky) ctx.drawImage(sky, 0, 0);
        else { fill(ctx, 0, 0, W, 120, '#8fd3ff'); fill(ctx, 0, 120, W, 200, '#eaaded'); }

        for (var i = 0; i < STARS.length; i++) {
            var st = STARS[i], f = (Math.floor(t * 3) + st.ph) % 4;
            if (f === 3) continue;
            if (f === 1) {
                fill(ctx, st.x, st.y, 2, 2, WHITE);
                fill(ctx, st.x - 4, st.y, 2, 2, WHITE); fill(ctx, st.x + 4, st.y, 2, 2, WHITE);
                fill(ctx, st.x, st.y - 4, 2, 2, WHITE); fill(ctx, st.x, st.y + 4, 2, 2, WHITE);
            } else {
                fill(ctx, st.x, st.y, 2, 2, WHITE);
            }
        }
        for (var c = 0; c < CLOUDS.length; c++) {
            var cl = CLOUDS[c];
            var width = 16 * cl.s;
            S.draw(ctx, 'scenecloud', Math.round(flow(-width + cl.x, t, cl.v, W, width)), cl.y, cl.s, { tint: CLOUD_TINT });
        }
        for (var l = 0; l < LANTERNS.length; l++) {
            var la = LANTERNS[l];
            S.draw(ctx, 'lantern', Math.round(flow(la.x, t, la.v, W, 20)), Math.round(la.y + Math.sin(t * 1.4 + la.ph) * 4), 1);
        }
    }

    /* ---------------------------------------------------------------- 跑道 */
    function drawTrack(ctx, t, scroll, progress) {
        var off = (t * scroll * 0.5) % 16, i, x, y;
        fill(ctx, 0, 30, 2, 268, WHITE);
        fill(ctx, W - 2, 30, 2, 268, WHITE);
        for (i = 1; i < L.COUNT; i++) {
            x = L.laneLeft(i) - 1;
            for (y = 14; y < 300; y += 16) fill(ctx, x, y + off, 2, 8, WHITE);
        }

        /* 终点线：随进度自上而下逼近 */
        var gy = Math.round(L.gateY(progress) / 2) * 2;
        for (x = 0; x < W; x += 8) {
            for (var k = 0; k < 2; k++) {
                fill(ctx, x, gy + k * 8, 8, 8, ((x / 8 + k) % 2 === 0) ? INK : WHITE);
            }
        }
        fill(ctx, 2, gy - 18, 40, 16, INK);
        text(ctx, 'GOAL', 5, gy - 15, P.y);

        /* 底部云台：角色站在上面 */
        fill(ctx, 0, 298, W, 2, INK);
        fill(ctx, 0, 300, W, 20, WHITE);
        fill(ctx, 0, 312, W, 8, P.W);
        for (x = 0; x < W; x += 24) {
            fill(ctx, x + 2, 290, 20, 2, INK);
            fill(ctx, x, 292, 2, 6, INK);
            fill(ctx, x + 22, 292, 2, 6, INK);
            fill(ctx, x + 2, 292, 20, 6, WHITE);
        }
    }

    /* ---------------------------------------------------------------- 顶部实时竞速条 */
    function drawRaceStrip(ctx, s) {
        fill(ctx, 2, 2, W - 4, 24, INK);
        fill(ctx, 2, 2, W - 4, 2, INK3);
        text(ctx, 'RACE', 6, 7, PAPER);
        fill(ctx, 36, 17, 110, 2, INK3);
        fill(ctx, 34, 13, 4, 10, WHITE);
        fill(ctx, 146, 13, 4, 10, P.y);
        for (var i = 0; i < s.rivals.length; i++) {
            var r = s.rivals[i];
            var rx = Math.round(36 + 110 * Math.min(100, r.progress) / 100);
            fill(ctx, rx - 4, 13, 8, 2, INK);
            fill(ctx, rx - 3, 15, 6, 6, RIVAL_COLOR[r.tint] || P.v);
        }
        var px = Math.round(36 + 110 * Math.min(100, s.progress) / 100);
        fill(ctx, px - 4, 11, 8, 12, INK);
        fill(ctx, px - 2, 13, 4, 8, P.p);
        fill(ctx, px - 2, 13, 2, 2, WHITE);
        text(ctx, '#' + (s.rank || '--'), 154, 7, P.y);
    }

    /* ---------------------------------------------------------------- 道具（统一 2 倍像素） */
    var ITEM_ART = { star: 'star', gift: 'gift', heart: 'heart', cloud: 'cloud' };
    function drawItems(ctx, s, t) {
        var blink = Math.floor(t * 4) % 2 === 0;
        for (var i = 0; i < s.items.length; i++) {
            var it = s.items[i];
            if (!it.alive) continue;
            var name = ITEM_ART[it.type] || 'star', sz = S.size(name);
            var ox = Math.round(it.x + (C.ITEM_SIZE - sz.w * 2) / 2);
            var oy = Math.round(it.y + (C.ITEM_SIZE - sz.h * 2) / 2 + (Math.sin(t * 4 + it.y * 0.05) > 0 ? 2 : 0));
            if (it.type === 'star' && blink) {
                fill(ctx, ox - 4, oy + 6, 2, 2, P.y); fill(ctx, ox + 18, oy + 6, 2, 2, P.y);
                fill(ctx, ox + 6, oy - 4, 2, 2, WHITE); fill(ctx, ox + 10, oy + 18, 2, 2, WHITE);
            }
            /* 乌云障碍用银灰色，与远景的淡紫云明确区分 */
            S.draw(ctx, name, ox, oy, 2, it.type === 'cloud' ? { tint: { W: '#9babb2', s: '#625565' } } : null);
        }
    }

    /* ---------------------------------------------------------------- 角色 */
    function drawPlayer(ctx, s, t) {
        var p = s.player, x = Math.round(p.x), top = Math.round(p.y);
        var running = s.speed > 20;
        var bob = running ? (Math.floor(t * 10) % 2 ? -2 : 0) : 0;

        fill(ctx, x + 4, 300, 24, 4, P.W);                       /* 云台上的落影 */

        if (s.fever > 0) {                                       /* 虚线光环，按帧闪 */
            var on = Math.floor(t * 8) % 2 === 0, a = x - 6, b = top - 6 + bob;
            for (var d = 0; d < 44; d += 8) {
                if (!on && (d / 8) % 2) continue;
                fill(ctx, a + d, b, 4, 2, P.y); fill(ctx, a + d, b + 42, 4, 2, P.y);
                fill(ctx, a, b + d, 2, 4, P.y); fill(ctx, a + 42, b + d, 2, 4, P.y);
            }
        }
        if (s.speed > 110) {                                     /* 身后的冲刺尾迹 */
            var n = Math.min(3, Math.floor((s.speed - 90) / 50));
            for (var i = 0; i < n; i++) {
                fill(ctx, x + 8 + i * 8, top + 36 + i * 6, 4, 6, i % 2 ? P.W : WHITE);
            }
        }

        var flicker = p.invuln > 0 && Math.floor(t * 12) % 2 === 0;
        S.draw(ctx, p.frame ? 'player2' : 'player', x, top + bob, 2, flicker ? { tint: { o: P.P, w: P.W, k: P.K } } : null);

        if (s.combo >= 5) {
            var tx = Math.max(2, Math.min(W - 44, x - 6));
            text(ctx, s.combo + ' HIT', tx, top - 38, P.y, true);
            if (s.combo >= C.COMBO_STEP) text(ctx, 'x' + PG.Rules.comboMultiplier(s.combo).toFixed(2), tx + 4, top - 22, WHITE, true);
        }
    }

    /* ---------------------------------------------------------------- 特效 */
    function drawEffects(ctx, s) {
        for (var i = 0; i < s.particles.length; i++) {
            var p = s.particles[i];
            fill(ctx, p.x, p.y, p.size, p.size, p.life / p.maxLife < 0.35 ? INK3 : p.color);
        }
        for (var j = 0; j < s.floatTexts.length; j++) {
            var f = s.floatTexts[j];
            var fx = Math.max(2, Math.min(W - 44, Math.round(f.x)));
            text(ctx, f.text, fx, Math.round(f.y), f.color, true);
        }
    }

    function drawSpeedLines(ctx, s, t) {
        if (s.speed < 130) return;
        for (var i = 0; i < LINES.length; i++) {
            var l = LINES[i];
            fill(ctx, l.x, Math.round(flow(l.ph, t, 160 + s.speed, 268, 24) + 30), 2, l.len, WHITE);
        }
    }

    function draw(ctx, s) {
        var cw = ctx.canvas ? ctx.canvas.width : W;
        var k = cw > 0 ? cw / W : 1;                 /* 设备像素整数倍 */
        ctx.setTransform(k, 0, 0, k, 0, 0);
        ctx.imageSmoothingEnabled = false;
        var t = s.time;
        drawBackdrop(ctx, t);
        drawTrack(ctx, t, s.scroll, s.progress);
        drawSpeedLines(ctx, s, t);
        drawRaceStrip(ctx, s);
        drawItems(ctx, s, t);
        drawPlayer(ctx, s, t);
        drawEffects(ctx, s);
    }

    PG.Renderer = { draw: draw, fill: fill, pixelText: text };
})(window);
