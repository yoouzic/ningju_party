/* ==========================================================================
   board.js —— 晚会大屏：当前环节 / 倒计时 / 前 10 名 / 扫码入口 / 全场数据 / 抽奖
   ----------------------------------------------------------------------------
   · 只调用 PG.Net.status()（每 2 秒一次），服务端一次返回 round / board / stats / draws
   · 练习模式（file:// 或服务端不可达）不伪造任何成绩，只显示空榜与明确提示
   · 服务端文本一律经 escapeHtml 转义后才拼入 innerHTML，单值用 textContent
   ========================================================================== */
(function (global) {
    'use strict';

    var POLL_MS = 2000;
    var TOP_N = 10;
    var DRAW_N = 6;
    var WATCHDOG_MS = 8000;
    var htmlCache = {};

    function $(id) { return global.document.getElementById(id); }

    /* 榜单/抽奖记录每 2 秒刷新一次，内容不变时不重写 DOM（也避免 aria-live 反复播报） */
    function setHtml(el, html) {
        if (!el) return;
        if (htmlCache[el.id] === html) return;
        htmlCache[el.id] = html;
        el.innerHTML = html;
    }

    /* 外部文本转义：优先用 utils.js 的 PG.Utils.escapeHtml，缺失时用本地等价实现 */
    function escapeHtml(value) {
        var utils = global.PG && global.PG.Utils;
        if (utils && typeof utils.escapeHtml === 'function') return utils.escapeHtml(value);
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function toInt(value, fallback) {
        var n = Number(value);
        if (!global.isFinite(n)) return fallback || 0;
        return Math.floor(n);
    }

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    /* 千分位：服务端步数可能上千，纯字符串处理避免依赖国际化 API */
    function group(n) {
        var s = String(Math.max(0, toInt(n, 0)));
        var out = '';
        var c = 0;
        for (var i = s.length - 1; i >= 0; i--) {
            out = s.charAt(i) + out;
            c++;
            if (c % 3 === 0 && i > 0) out = ',' + out;
        }
        return out;
    }

    /* 服务端 elapsed 单位为毫秒；缺失时返回空串，避免把 null 显示成 0.0 秒 */
    function secondsText(ms) {
        if (ms === null || ms === undefined || ms === '') return '';
        var v = Number(ms);
        if (!global.isFinite(v) || v < 0) return '';
        return (v / 1000).toFixed(1) + ' 秒';
    }

    function clock() {
        var d = new Date();
        function p(v) { return v < 10 ? '0' + v : '' + v; }
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    function stageText(round) {
        if (!round) return '等待主持人开赛';
        if (round.status !== 'running') return '环节已结束';
        if (round.kind === 'quiz') return '环节 02 · 线上答题竞速';
        if (round.kind === 'shake') return '环节 01 · 摇一摇拼手速';
        return '等待主持人开赛';
    }

    function boardTitle(kind) {
        return kind === 'quiz' ? '答题正确榜 · 前 10 名' : '实时摇动榜 · 前 10 名';
    }

    function emptyText(kind) {
        return kind === 'quiz'
            ? '还没有人提交 · 答题后这里会显示前 10 名'
            : '还没有人开始摇动 · 等待第一位信息员';
    }

    /* 摇一摇：名次 / 昵称 / 步数（规定时间内摇得越多越靠前）
       答题：名次 / 昵称 / 用时 / 正确题数 */
    function rowHtml(entry, index, kind) {
        var rank = toInt(entry.rank, index + 1);
        if (rank < 1) rank = index + 1;
        var cls = 'board-row';
        if (rank <= 3) cls += ' board-row--top' + rank;
        var html = '<li class="' + cls + '">' +
            '<span class="bl__no">' + pad2(rank) + '</span>' +
            '<span class="bl__name">' + escapeHtml(entry.name || '信息员') + '</span>';

        if (kind === 'quiz') {
            var used = secondsText(entry.elapsed);
            var correct = toInt(entry.score, 0);
            var total = toInt(entry.total, 0);
            /* total 缺失或为 0（题库未配置）时只显示题数，避免出现「x/0 题」 */
            var scoreText = total > 0
                ? correct + '/' + total + '<small>题</small>'
                : correct + '<small>题</small>';
            html += '<span class="bl__meta">' + (used ? '用时 ' + used : '已提交') + '</span>' +
                '<span class="bl__score">' + scoreText + '</span>';
        } else {
            html += '<span class="bl__meta"></span>' +
                '<span class="bl__score">' + group(entry.score) + '<small>步</small></span>';
        }
        return html + '</li>';
    }

    /* draws.balls 可能是 JSON 字符串（server.py 写入时 json.dumps），也可能已是对象 */
    function parseBalls(raw) {
        if (!raw) return null;
        if (typeof raw === 'object') return raw;
        try {
            var obj = JSON.parse(String(raw));
            return obj && typeof obj === 'object' ? obj : null;
        } catch (e) {
            return null;
        }
    }

    function drawRowHtml(draw) {
        var pending = draw.prize === null || draw.prize === undefined || draw.prize === '';
        var html = '<li class="board-draw">' +
            '<span class="board-draw__no">' + escapeHtml(draw.card_no || '—') + '</span>' +
            '<span class="board-draw__who">' + escapeHtml(draw.player || '未知信息员') + '</span>' +
            '<span class="board-draw__prize' + (pending ? ' is-pending' : '') + '">' +
            (pending ? '待开奖' : escapeHtml(draw.prize)) + '</span>';
        var balls = parseBalls(draw.balls);
        if (balls) {
            var keys = Object.keys(balls);
            if (keys.length) {
                html += '<span class="draw-balls">';
                for (var i = 0; i < keys.length; i++) {
                    html += '<span>' + escapeHtml(keys[i]) + '<b>' + escapeHtml(balls[keys[i]]) + '</b></span>';
                }
                html += '</span>';
            }
        }
        return html + '</li>';
    }

    function boot() {
        var PG = global.PG;
        var doc = global.document;

        var modeEl = $('board-mode');
        var stageEl = $('board-stage');
        var statusEl = $('board-status');
        var countEl = $('board-countdown');
        var totalEl = $('board-total');
        var titleEl = $('board-title');
        var entriesEl = $('board-entries');
        var listEl = $('board-list');
        var noteEl = $('board-note');
        var timeEl = $('board-time');
        var joinUrlEl = $('join-url');
        var quizUrlEl = $('quiz-url');
        var joinImg = $('qr-join');
        var quizImg = $('qr-quiz');
        var joinFrame = $('qr-join-frame');
        var quizFrame = $('qr-quiz-frame');
        var drawListEl = $('draw-list');
        var statPlayersEl = $('stat-players');
        var statCardsEl = $('stat-cards');
        var statRewardsEl = $('stat-rewards');
        var statDrawsEl = $('stat-draws');

        var icons = doc.querySelectorAll('[data-icon]');
        for (var n = 0; n < icons.length; n++) {
            var node = icons[n];
            PG.Sprites.mount(node, node.getAttribute('data-icon'),
                parseInt(node.getAttribute('data-scale') || '2', 10));
        }

        function setMode(online) {
            modeEl.textContent = online ? '全场实时' : '本地演示';
            modeEl.className = 'plate ' + (online ? 'plate--online' : 'plate--quiet');
        }

        function setNote(text, warn) {
            noteEl.textContent = text;
            noteEl.className = 'board-now__note' + (warn ? ' is-warn' : '');
        }

        function renderRound(round) {
            var running = !!(round && round.status === 'running');
            stageEl.textContent = stageText(round);
            if (!round) {
                statusEl.textContent = '待机';
                statusEl.className = 'pill pill--wait';
            } else if (running) {
                statusEl.textContent = '进行中';
                statusEl.className = 'pill pill--live';
            } else {
                statusEl.textContent = '已结束';
                statusEl.className = 'pill pill--done';
            }
            if (running) {
                countEl.textContent = String(Math.max(0, toInt(round.seconds_left, 0)));
                countEl.className = 'num-big';
            } else {
                countEl.textContent = '--';
                countEl.className = 'num-big num-big--idle';
            }
        }

        function renderBoard(entries, kind, total) {
            titleEl.textContent = boardTitle(kind);
            entriesEl.textContent = (total === null || total === undefined)
                ? '—'
                : '上榜 ' + toInt(total, 0) + ' 人';
            var n = Math.min(TOP_N, entries.length);
            if (!n) {
                setHtml(listEl, '<li class="board-list__empty">' + emptyText(kind) + '</li>');
                return;
            }
            var html = '';
            for (var i = 0; i < n; i++) html += rowHtml(entries[i], i, kind);
            setHtml(listEl, html);
        }

        function renderStats(stats, draws) {
            if (!stats) {
                totalEl.textContent = '—';
                statPlayersEl.textContent = '—';
                statCardsEl.textContent = '—';
                statRewardsEl.textContent = '—';
                statDrawsEl.textContent = '—';
                return;
            }
            totalEl.textContent = stats.players === undefined ? '—' : toInt(stats.players, 0) + ' 人';
            statPlayersEl.textContent = stats.players === undefined ? '—' : String(toInt(stats.players, 0));
            statCardsEl.textContent = (stats.cards_used === undefined || stats.cards_total === undefined)
                ? '—'
                : toInt(stats.cards_used, 0) + ' / ' + toInt(stats.cards_total, 0);
            statRewardsEl.textContent = stats.rewards === undefined ? '—' : String(toInt(stats.rewards, 0));
            statDrawsEl.textContent = draws ? draws.length + ' 条' : '—';
        }

        function renderDraws(draws) {
            var list = draws || [];
            if (!list.length) {
                setHtml(drawListEl, '<li class="board-draws__empty">还没有抽奖记录 · 主持人抽号后这里会显示</li>');
                return;
            }
            /* 大屏只展示最新 6 条，完整历史在主持人控制台 */
            var n = Math.min(DRAW_N, list.length);
            var html = '';
            for (var i = 0; i < n; i++) html += drawRowHtml(list[i]);
            setHtml(drawListEl, html);
        }

        function renderAll(st) {
            var board = st.board || {};
            var round = st.round || board.round || null;
            var kind = board.kind || (round && round.kind) || 'shake';
            var draws = st.draws || null;

            renderRound(round);
            renderBoard(board.entries || [], kind, board.total);
            renderStats(st.stats || null, draws);
            renderDraws(draws);
            timeEl.textContent = clock();
            setNote('实时数据每 2 秒自动刷新', false);
        }

        function renderPractice() {
            renderRound(null);
            renderBoard([], 'shake', null);
            renderStats(null, null);
            renderDraws(null);
            timeEl.textContent = '--:--:--';
            setNote('未连接晚会服务端，当前无实时数据', true);
        }

        function showQrFallback(frame, img, note, url) {
            if (!frame) return;
            if (frame.getAttribute('data-fallback') === '1') {
                var oldNote = frame.querySelector('.qr-fallback__note');
                var oldUrl = frame.querySelector('.qr-fallback__url');
                if (oldNote) oldNote.textContent = note;
                if (oldUrl) oldUrl.textContent = url;
                return;
            }
            frame.setAttribute('data-fallback', '1');
            frame.className = 'qr-frame qr-frame--fallback';
            if (img) {
                img.className = 'hidden';
                img.onerror = null;
                img.removeAttribute('src');
            }
            var box = doc.createElement('div');
            box.className = 'qr-fallback';
            var noteEl = doc.createElement('p');
            noteEl.className = 'qr-fallback__note';
            noteEl.textContent = note;
            var urlEl = doc.createElement('p');
            urlEl.className = 'qr-fallback__url';
            urlEl.textContent = url;
            box.appendChild(noteEl);
            box.appendChild(urlEl);
            frame.appendChild(box);
        }

        function setupQr(online) {
            /* 部署在子路径（如 /pixel-rush/）时，加入地址指向该目录而非站点根 */
            var base = global.location.origin + global.location.pathname.replace(/board\.html$/, '');
            var quizPage = base + 'quiz.html';

            if (global.location.protocol === 'file:') {
                joinUrlEl.textContent = '本地演示：请运行 python server.py 后刷新本页';
                quizUrlEl.textContent = '本地演示：答题页需连接晚会服务端';
                showQrFallback(joinFrame, joinImg, '本地演示模式，扫码不可用', '请运行 python server.py 后刷新');
                showQrFallback(quizFrame, quizImg, '本地演示模式，扫码不可用', '请运行 python server.py 后刷新');
                return;
            }

            joinUrlEl.textContent = base;
            quizUrlEl.textContent = quizPage;

            if (!online) {
                showQrFallback(joinFrame, joinImg, '未连接晚会服务端，扫码不可用', base);
                showQrFallback(quizFrame, quizImg, '未连接晚会服务端，扫码不可用', quizPage);
                return;
            }

            joinImg.onerror = function () {
                showQrFallback(joinFrame, joinImg, '服务器未安装二维码组件，请直接打开地址', base);
            };
            quizImg.onerror = function () {
                showQrFallback(quizFrame, quizImg, '服务器未安装二维码组件，请直接打开地址', quizPage);
            };
            joinImg.src = PG.Net.qrUrl(base);
            quizImg.src = PG.Net.qrUrl(quizPage);
        }

        var busy = false;
        var pollToken = 0;

        function failPoll() {
            setNote('晚会服务端暂时无响应，正在重试…', true);
        }

        /* 每次轮询都有本地看门狗：即使 status() 的 Promise 永不落定（断网、
           标签页挂起），8 秒后也强制释放 busy，下一轮继续请求。
           net.js 自身的 fetch 超时为 6 秒，正常路径不会触发看门狗。 */
        function tick() {
            if (busy) return;
            busy = true;
            var token = ++pollToken;
            var settled = false;
            var timer = global.setTimeout(function () {
                if (settled) return;
                settled = true;
                if (token === pollToken) busy = false;
                failPoll();
            }, WATCHDOG_MS);

            function finish(st) {
                if (settled) return;
                settled = true;
                global.clearTimeout(timer);
                if (token === pollToken) busy = false;
                if (!st) {
                    failPoll();
                    return;
                }
                renderAll(st);
            }

            var pending;
            try {
                pending = PG.Net.status();
            } catch (e) {
                finish(null);
                return;
            }
            if (!pending || typeof pending.then !== 'function') {
                finish(null);
                return;
            }
            pending.then(finish, function () { finish(null); });
        }

        PG.Net.detect().then(function (mode) {
            var online = mode === 'online';
            setMode(online);
            setupQr(online);
            if (!online) {
                renderPractice();
                return;
            }
            tick();
            global.setInterval(tick, POLL_MS);
        });
    }

    if (global.document.readyState === 'loading') {
        global.document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})(window);
