/* ==========================================================================
   sprites.js —— 程序化像素美术（角色 / 对手 / 道具 / 图标 / 场景装饰）
   ----------------------------------------------------------------------------
   点阵用「游程串」描述：'5.6o5.' = 5 个透明 + 6 个描边 + 5 个透明，
   宽度由数字精确给出，新增精灵不会因肉眼数格子而错位。
   上色遵循像素画惯例：
     · 调色板直接取 Resurrect 64 色阶，所有精灵共用同一套色；
     · 暗面不用「同色加深」，而是偏向冷色（白 → 淡紫、肤 → 粉）；
     · 场景内所有精灵统一 2 倍绘制，保证像素密度一致。
   ========================================================================== */
(function (global) {
    'use strict';
    var PG = global.PG = global.PG || {};

    var PALETTE = {
        '.': null,           // 透明
        'o': '#2e222f',      // 主描边
        'O': '#3e3546',      // 次描边
        'w': '#ffffff',      // 白
        'W': '#eaaded',      // 白的暗面（偏冷紫）
        'p': '#f04f78',      // 粉
        'P': '#c32454',      // 粉·暗
        'q': '#831c5d',      // 粉·最深
        'b': '#4d9be6',      // 蓝
        'B': '#4d65b4',      // 蓝·暗
        'y': '#f9c22b',      // 黄
        'Y': '#f79617',      // 黄·暗
        'k': '#fdcbb0',      // 肤色
        'K': '#fca790',      // 肤色暗面
        'c': '#f68181',      // 腮红
        'h': '#6b3e75',      // 头发
        'g': '#1ebc73',      // 绿
        'G': '#239063',
        'v': '#a884f3',      // 紫
        'V': '#905ea9',
        'r': '#e83b3b',      // 红
        's': '#9babb2'       // 银灰
    };

    /* 把 '3.2o6P2o3.' 展开成 '...ooPPPPPPoo...' */
    function decodeRow(str) {
        var out = '', i = 0, num, ch, n, k;
        while (i < str.length) {
            num = '';
            while (i < str.length && str.charAt(i) >= '0' && str.charAt(i) <= '9') {
                num += str.charAt(i); i++;
            }
            if (i >= str.length) break;
            ch = str.charAt(i); i++;
            n = num ? parseInt(num, 10) : 1;
            for (k = 0; k < n; k++) out += ch;
        }
        return out;
    }

    function make(name, w, rows) {
        var data = [], i, row, actual;
        for (i = 0; i < rows.length; i++) {
            row = decodeRow(rows[i]);
            actual = row.length;
            if (actual !== w) {
                if (global.console && global.console.warn) {
                    global.console.warn('[pixel-rush] sprite "' + name + '" row ' + i + ' width ' + actual + ' != ' + w);
                }
                if (actual < w) { while (row.length < w) row += '.'; }
                else { row = row.slice(0, w); }
            }
            data.push(row);
        }
        return { w: w, h: data.length, rows: data };
    }

    /* ---------------------------------------------------------------- 角色「小凝」16×16，两帧跑步 */
    var PLAYER_A = [
        '5.6o5.',                     // 帽顶描边
        '3.2o6P2o3.',                 // 粉帽
        '2.1o10P1o2.',
        '2.1o1P2p4w2p1P1o2.',        // 帽徽
        '1.1o12b1o1.',                // 蓝帽檐（亮）
        '1.1o12B1o1.',                // 帽檐暗面
        '2.1o1h8k1h1o2.',            // 刘海 + 脸
        '2.1o1h1k1o1w2k1o1w1k1h1o2.',// 眼睛
        '2.1o1h2c1k2P1k2c1h1o2.',    // 腮红 + 嘴
        '2.1o1K8k1K1o2.',            // 下巴
        '3.10o3.',                    // 身体轮廓
        '2.1o1b8w1b1o2.',            // 白色上衣
        '2.1o1b1w6p1w1b1o2.',        // 粉色徽章
        '3.1o2W4w2W1o3.',            // 上衣下摆（冷色暗面）
        '4.2o4.2o4.',                 // 双腿（落地帧）
        '4.2B4.2B4.'                  // 鞋
    ];
    var PLAYER_B = PLAYER_A.slice();
    PLAYER_B[10] = '1.2o10o2o1.';         // 摆臂
    PLAYER_B[12] = '1.2o1b1w6p1w1b2o1.';
    PLAYER_B[14] = '3.3o3.2o5.';          // 交替迈步
    PLAYER_B[15] = '3.3B3.2B5.';

    var DEFS = {
        player:  { w: 16, rows: PLAYER_A },
        player2: { w: 16, rows: PLAYER_B },

        /* 对手吉祥物 10×10，'P' 可被 tint 覆盖成不同配色 */
        rival: { w: 10, rows: [
            '3.4o3.',
            '2.1o4P1o2.',
            '1.1o6P1o1.',
            '1o8P1o',
            '1o1P6k1P1o',
            '1o1P1k1o2k1o2P1o',
            '1o1P2k2P2k1P1o',
            '1o8P1o',
            '2.1o4P1o2.',
            '3.4o3.'
        ] },

        star: { w: 8, rows: [
            '3.2o3.',
            '2.1o2y1o2.',
            '1.1o1Y3y1o1.',
            '1o6y1o',
            '1.1o4y1o1.',
            '2.1o2Y1o2.',
            '1.1o1y2.1y1o1.',
            '2o4.2o'
        ] },

        /* 礼物 8×8：蓝盒黄带，与星星同密度 */
        gift: { w: 8, rows: [
            '1.2o2.2o1.',
            '1.1o4y1o1.',
            '8o',
            '1o2b2y2b1o',
            '1o2b2y2b1o',
            '1o2B2Y2B1o',
            '1o2B2Y2B1o',
            '8o'
        ] },

        heart: { w: 8, rows: [
            '1.2o2.2o1.',
            '1.1o4r1o1.',
            '1o1w5r1o',
            '1o6r1o',
            '1.1o4r1o1.',
            '2.1o2r1o2.',
            '3.1o1o3.',
            '4.2o2.'
        ] },

        /* 乌云（障碍）12×8 */
        cloud: { w: 12, rows: [
            '4.4o4.',
            '2.2o4W2o2.',
            '1.1o8W1o1.',
            '1o2W1o4W1o2W1o',       // 一对「生气」的眼睛
            '1o10W1o',
            '1o4W2s4W1o',
            '1.1o8s1o1.',
            '3.6o3.',
            '4.1o2.1o4.'
        ] },

        bolt: { w: 8, rows: [
            '4.2y2.',
            '3.2y3.',
            '2.2y2Y2.',
            '4.2Y2.',
            '3.2Y3.',
            '2.2Y4.',
            '8.',
            '8.'
        ] },

        trophy: { w: 10, rows: [
            '1.8o1.',
            '1o8y1o',
            '1o2Y4y2Y1o',
            '1.1o6Y1o1.',
            '3.1o2Y1o3.',
            '3.1o2Y1o3.',
            '2.1o4y1o2.',
            '1.1o6Y1o1.',
            '1o8O1o',
            '1.8o1.'
        ] },

        card: { w: 10, rows: [
            '1.8o1.',
            '1o8p1o',
            '1o2w4y2w1o',
            '1o2w4y2w1o',
            '1o8p1o',
            '1o2y4p2y1o',
            '1o8p1o',
            '1.8o1.'
        ] },

        /* 孔明灯 8×8 */
        lantern: { w: 8, rows: [
            '3.2o3.',
            '2.1o2y1o2.',
            '1.1o4y1o1.',
            '1o6Y1o',
            '1o6Y1o',
            '1.1o4Y1o1.',
            '2.1o2y1o2.',
            '3.2o3.'
        ] },

        /* 纸飞机 8×8 */
        plane: { w: 8, rows: [
            '7.1w',
            '5.2w1.',
            '3.2w3.',
            '1.2w5.',
            '1w2.5.',
            '1w7.',
            '8.',
            '8.'
        ] },

        /* 远景云 16×7（场景里以淡紫色绘制，表示空气透视） */
        scenecloud: { w: 16, rows: [
            '5.6o5.',
            '3.1o10w1o1.',
            '2.1o12w1o',
            '1o14w1o',
            '1o6w2W6w1o',
            '2.1o12W1o',
            '4.8o4.'
        ] }
    };

    var SPRITES = {};
    Object.keys(DEFS).forEach(function (name) {
        SPRITES[name] = make(name, DEFS[name].w, DEFS[name].rows);
    });

    function palette(tint) {
        if (!tint) return PALETTE;
        var p = {}, k;
        for (k in PALETTE) { if (Object.prototype.hasOwnProperty.call(PALETTE, k)) p[k] = PALETTE[k]; }
        for (k in tint) { if (Object.prototype.hasOwnProperty.call(tint, k)) p[k] = tint[k]; }
        return p;
    }

    /* 绘制：连续同色像素合并成一次 fillRect */
    function draw(ctx, name, x, y, scale, opts) {
        var s = SPRITES[name];
        if (!s) return;
        opts = opts || {};
        var sc = scale || 1;
        var pal = palette(opts.tint);
        for (var r = 0; r < s.h; r++) {
            var row = s.rows[r], c = 0;
            while (c < s.w) {
                var key = row.charAt(c), run = 1;
                while (c + run < s.w && row.charAt(c + run) === key) run++;
                var color = pal[key];
                if (color) {
                    ctx.fillStyle = color;
                    ctx.fillRect(x + c * sc, y + r * sc, run * sc, sc);
                }
                c += run;
            }
        }
    }

    /* 把像素图标挂到 HTML 的 <i class="px-icon" data-icon="..."> 上 */
    function mount(el, name, scale) {
        var s = SPRITES[name];
        if (!s || !el) return;
        var sc = scale || 2;
        var canvas = global.document.createElement('canvas');
        canvas.width = s.w * sc;
        canvas.height = s.h * sc;
        canvas.setAttribute('aria-hidden', 'true');
        var ctx = canvas.getContext('2d');
        if (ctx) draw(ctx, name, 0, 0, sc);
        el.appendChild(canvas);
    }

    PG.Sprites = {
        PALETTE: PALETTE,
        get: function (name) { return SPRITES[name]; },
        size: function (name) { return SPRITES[name] ? { w: SPRITES[name].w, h: SPRITES[name].h } : { w: 0, h: 0 }; },
        draw: draw,
        mount: mount
    };
})(window);
