/* ==========================================================================
   utils.js —— 纯函数工具：数学 / 随机 / 碰撞 / 格式化
   ========================================================================== */
(function (global) {
    'use strict';
    var PG = global.PG = global.PG || {};

    PG.Utils = {
        clamp: function (v, min, max) { return v < min ? min : (v > max ? max : v); },
        lerp: function (a, b, t) { return a + (b - a) * t; },
        rand: function (min, max) { return min + Math.random() * (max - min); },
        randInt: function (min, max) { return Math.floor(min + Math.random() * (max - min + 1)); },

        /* 按权重表抽取 key：table = { star: 52, gift: 20, ... } */
        weightedPick: function (table) {
            var total = 0, key;
            for (key in table) { if (Object.prototype.hasOwnProperty.call(table, key)) total += table[key]; }
            var r = Math.random() * total;
            for (key in table) {
                if (!Object.prototype.hasOwnProperty.call(table, key)) continue;
                r -= table[key];
                if (r <= 0) return key;
            }
            return Object.keys(table)[0];
        },

        /* 轴对齐矩形碰撞 */
        hits: function (a, b) {
            return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        },

        fmtTime: function (sec) {
            var s = Math.max(0, sec);
            return s.toFixed(1);
        },

        pad2: function (n) { return n < 10 ? '0' + n : '' + n; },

        /* HTML 转义：昵称等外部文本拼进 innerHTML 前必须过一遍 */
        escapeHtml: function (s) {
            return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
            });
        },

        /* 数字千分位，纯字符串处理避免依赖国际化 API */
        group: function (n) {
            var s = String(Math.round(n)), out = '', c = 0;
            for (var i = s.length - 1; i >= 0; i--) {
                out = s.charAt(i) + out;
                c++;
                if (c % 3 === 0 && i > 0) out = ',' + out;
            }
            return out;
        }
    };
})(window);
