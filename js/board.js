/* ==========================================================================
   board.js —— 大屏实时竞速榜：每 2 秒拉取全场成绩
   由 server.py 托管时为真实榜单；file:// 打开时为本地模拟数据（便于预演）
   ========================================================================== */
(function (global) {
    'use strict';

    function $(id) { return global.document.getElementById(id); }

    function boot() {
        var PG = global.PG;
        var list = $('big-board');
        var modeEl = $('board-mode');
        var urlEl = $('join-url');
        var totalEl = $('board-total');
        var timeEl = $('board-time');

        var icons = global.document.querySelectorAll('[data-icon]');
        for (var n = 0; n < icons.length; n++) {
            var node = icons[n];
            PG.Sprites.mount(node, node.getAttribute('data-icon'), parseInt(node.getAttribute('data-scale') || '2', 10));
        }

        function clock() {
            var d = new Date();
            function p(v) { return v < 10 ? '0' + v : '' + v; }
            return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
        }

        function render(entries, total) {
            timeEl.textContent = clock();
            totalEl.textContent = (total || 0) + ' 人';
            if (!entries.length) {
                list.innerHTML = '<li class="bigboard__empty">还没有成绩 · 等待第一位信息员完成冲刺</li>';
                return;
            }
            var html = '';
            var n = Math.min(10, entries.length);
            for (var i = 0; i < n; i++) {
                var e = entries[i];
                var name = String(e.name || '信息员').replace(/[&<>"]/g, '');
                html += '<li>' +
                    '<span class="bb__no">' + (i < 9 ? '0' : '') + (i + 1) + '</span>' +
                    '<span class="bb__name">' + name + '</span>' +
                    '<span class="bb__score">' + PG.Utils.group(e.score) + '<small>分</small></span>' +
                    '</li>';
            }
            list.innerHTML = html;
        }

        PG.Net.detect().then(function (mode) {
            var online = mode === 'api';
            modeEl.textContent = online ? '全场实时' : '本地演示';
            modeEl.className = 'plate ' + (online ? 'plate--online' : 'plate--quiet');
            var tick = function () {
                PG.Net.board(20).then(function (entries) { render(entries || [], entries ? entries.length : 0); });
            };
            tick();
            global.setInterval(tick, 2000);
        });

        if (global.location.protocol === 'file:') {
            urlEl.textContent = '运行 python server.py 后，此处显示手机加入地址';
        } else {
            /* 部署在子路径（如 /pixel-rush/）时，加入地址应指向该目录而非站点根 */
            var base = global.location.pathname.replace(/board\.html$/, '');
            urlEl.textContent = global.location.origin + base;
        }
    }

    if (global.document.readyState === 'loading') {
        global.document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})(window);
