/* ==========================================================================
   admin.js —— ③ 主持人控制台
   ----------------------------------------------------------------------------
     · 登录 → 每 2 秒拉取 admin/state，只刷新只读区域。
     · 题库 textarea、比赛参数、奖品输入在登录后只填充一次，
       轮询绝不覆盖主持人正在编辑的内容。
     · 所有写操作走 PG.Net.adminPost（自动补 admin/ 前缀）；
       开赛/结算/作废/抽奖都由服务端裁定，本页只显示结果。
     · 服务端返回的文本一律用 textContent 写入，不拼 innerHTML。
   ========================================================================== */
(function (global) {
    'use strict';

    var doc = global.document;
    var POLL_MS = 2000;
    var TOKEN_KEY = 'ningju.admin.v2';   /* 与 net.js 的存储键一致，仅用于探测旧令牌 */

    var KIND_LABEL = { shake: '摇一摇', quiz: '答题' };
    var KIND_TITLE = {
        shake: '第①环节 · 摇一摇拼手速',
        quiz: '第②环节 · 线上答题竞速'
    };
    var STATUS_LABEL = { running: '进行中', closed: '已结算', void: '已作废', idle: '待开赛' };
    var ACTION_LABEL = {
        open_round: '开赛', close_round: '结算', void_round: '作废',
        settings: '参数', prizes: '奖品', questions: '题库',
        claim: '核销', draw_number: '抽号', draw_spin: '开奖',
        draw_reset: '清空抽奖', quiz_submit: '交卷'
    };

    var el = {};
    var state = null;
    var loggedIn = false;
    var rewardsSig = '';
    var sessionSeq = 0;      /* 手动登录会推进序号，启动恢复的迟到回调据此作废 */
    var actionBusy = {};     /* 消耗型动作在途标记，双击不会重复提交 */
    var inflight = false;
    var pending = false;
    var pollTimer = 0;
    var failCount = 0;
    var questionsLoaded = false;
    var settingsFilled = false;
    var prizesBuilt = false;

    /* ------------------------------------------------------------ 小工具 */
    function $(id) { return doc.getElementById(id); }

    function text(node, value) {
        if (node) node.textContent = value == null ? '' : String(value);
    }

    /* ok === true 绿色，ok === false 红色，其余保持中性 */
    function setMsg(node, msg, ok) {
        if (!node) return;
        node.textContent = msg || '';
        node.className = 'party-msg' +
            (msg && ok === true ? ' party-msg--ok' : '') +
            (msg && ok === false ? ' party-msg--err' : '');
    }

    function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    /* 服务端时间戳（秒）→ 本机 HH:MM:SS */
    function clock(ts) {
        var n = Number(ts);
        if (!n) return '--:--:--';
        var d = new Date(n * 1000);
        return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }

    function kindLabel(kind) { return KIND_LABEL[kind] || '未知环节'; }
    function statusLabel(status) { return STATUS_LABEL[status] || (status || '未知'); }

    function intVal(node, fallback) {
        var n = parseInt(node && node.value, 10);
        return isNaN(n) ? fallback : n;
    }

    function clampInt(node, min, max, fallback) {
        var n = parseInt(node && node.value, 10);
        if (isNaN(n)) n = fallback;
        if (n < min) n = min;
        if (n > max) n = max;
        if (node) node.value = String(n);
        return n;
    }

    /* ------------------------------------------------------------ 节点缓存 */
    function camel(id) {
        var parts = String(id).split('-');
        var out = parts[0];
        for (var i = 1; i < parts.length; i++) {
            out += parts[i].charAt(0).toUpperCase() + parts[i].slice(1);
        }
        return out;
    }

    function cacheEls() {
        var ids = [
            'mode-badge', 'admin-chip', 'admin-status', 'login-view', 'console-view',
            'admin-password', 'btn-login', 'login-msg', 'btn-logout',
            'round-kind', 'round-status', 'round-left', 'round-id', 'round-title',
            'open-duration', 'btn-open-shake', 'btn-open-quiz', 'btn-close-round',
            'btn-void-round', 'round-msg', 'round-result', 'round-top',
            'set-top-n', 'set-duration', 'set-target', 'set-gift', 'set-rate',
            'btn-save-settings', 'settings-msg',
            'stat-players', 'stat-cards', 'stat-draws',
            'q-count', 'questions-json', 'btn-save-questions', 'questions-msg',
            'prizes-body', 'prize-total', 'btn-save-prizes', 'prizes-msg',
            'rewards-body', 'claim-msg',
            'draw-number', 'draw-balls', 'draw-player', 'btn-draw-number',
            'draw-card', 'btn-spin', 'draw-prize', 'draw-msg', 'btn-draw-reset',
            'draw-history', 'audit-list'
        ];
        for (var i = 0; i < ids.length; i++) {
            el[camel(ids[i])] = $(ids[i]);
        }
    }

    function mountIcons() {
        var icons = doc.querySelectorAll('[data-icon]');
        for (var i = 0; i < icons.length; i++) {
            var node = icons[i];
            global.PG.Sprites.mount(node, node.getAttribute('data-icon'),
                parseInt(node.getAttribute('data-scale') || '2', 10));
        }
    }

    /* ------------------------------------------------------------ 视图 / 状态条 */
    function setView(which) {
        var loginOn = which === 'login';
        el.loginView.className = loginOn ? 'admin-login' : 'admin-login hidden';
        el.consoleView.className = loginOn ? 'admin-console hidden' : 'admin-console';
        clearPasswordUnlessTyping();
        text(el.adminChip, loginOn ? '未登录' : '已登录');
    }

    /* 切换视图时清掉输入框里的残留口令；主持人正在输入口令时保留 */
    function clearPasswordUnlessTyping() {
        if (el.adminPassword && doc.activeElement !== el.adminPassword) {
            el.adminPassword.value = '';
        }
    }

    function setStatus(kind, msg) {
        el.adminStatus.className = 'party-bar admin-status party-bar--' + kind;
        el.adminStatus.textContent = msg;
    }

    function hasSavedToken() {
        try {
            var raw = global.localStorage && global.localStorage.getItem(TOKEN_KEY);
            return !!(raw && raw !== '""' && raw !== 'null');
        } catch (e) {
            return false;
        }
    }

    /* 管理员令牌没有过期时间，轮询失败多半是网络抖动：
       只有在写操作被服务端明确拒绝时才结束会话，避免清掉主持人正在编辑的内容。 */
    function isAuthError(d) {
        if (!d || !d.error) return false;
        return d.error.indexOf('管理员登录') >= 0 || d.error.indexOf('未登录') >= 0;
    }

    function api(route, data) {
        return global.PG.Net.adminPost(route, data).then(function (d) {
            if (loggedIn && isAuthError(d)) {
                endSession('登录已失效，请重新输入口令', false);
            }
            return d;
        });
    }

    /* ------------------------------------------------------------ 清空 / 复位 */
    function resetDrawDisplay() {
        text(el.drawNumber, '---');
        el.drawNumber.className = 'num-big num-big--idle';
        renderBalls(null);
        text(el.drawPlayer, '持卡人：—');
        text(el.drawPrize, '待开奖');
        el.drawCard.value = '';
    }

    function clearRoundResult() {
        el.roundTop.innerHTML = '';
        el.roundResult.className = 'hidden';
    }

    function resetConsole() {
        state = null;
        rewardsSig = '';
        questionsLoaded = false;
        settingsFilled = false;
        prizesBuilt = false;

        el.questionsJson.value = '';
        el.prizesBody.innerHTML = '';
        el.rewardsBody.innerHTML = '';
        el.drawHistory.innerHTML = '';
        el.auditList.innerHTML = '';
        clearRoundResult();

        text(el.roundKind, '—');
        text(el.roundStatus, '—');
        text(el.roundLeft, '—');
        text(el.roundId, '—');
        text(el.roundTitle, '—');
        actionBusy = {};
        syncActionButtons();

        text(el.statPlayers, '0');
        text(el.statCards, '0 / 0');
        text(el.statDraws, '0');
        text(el.qCount, '当前模板 0 题');
        text(el.prizeTotal, '预计最多可发 0 人');
        resetDrawDisplay();

        setMsg(el.roundMsg, '');
        setMsg(el.settingsMsg, '');
        setMsg(el.questionsMsg, '');
        setMsg(el.prizesMsg, '');
        setMsg(el.claimMsg, '');
        setMsg(el.drawMsg, '');
    }

    /* ------------------------------------------------------------ 写操作互斥 */
    /* 开赛/结算/作废/抽号/开奖都是一次性动作：同一动作在途时忽略再次触发，
       双击只会发出一个 POST；轮询重绘也会参考标记，不会把按钮重新点亮。 */
    function syncActionButtons() {
        var r = state && state.round;
        el.btnOpenShake.disabled = !!actionBusy.open;
        el.btnOpenQuiz.disabled = !!actionBusy.open;
        el.btnCloseRound.disabled = !!actionBusy.close || !(r && r.status === 'running');
        el.btnVoidRound.disabled = !!actionBusy.void || !r;
        el.btnDrawNumber.disabled = !!actionBusy.number;
        el.btnSpin.disabled = !!actionBusy.spin;
    }

    function beginAction(key) {
        if (actionBusy[key]) return false;
        actionBusy[key] = true;
        syncActionButtons();
        return true;
    }

    function finishAction(key) {
        actionBusy[key] = false;
        syncActionButtons();
    }

    /* ------------------------------------------------------------ 轮次 */
    function renderRound(s) {
        var r = s.round;
        text(el.roundKind, r ? kindLabel(r.kind) : '无轮次');
        text(el.roundStatus, r ? statusLabel(r.status) : '待开赛');
        text(el.roundLeft, r && r.status === 'running' ? String(r.seconds_left) : '—');
        text(el.roundId, r ? '#' + r.id : '—');
        text(el.roundTitle, r ? (KIND_TITLE[r.kind] || '—') : '—');
        syncActionButtons();
    }

    function renderStatusBar(s) {
        var r = s.round;
        if (!r) {
            setStatus('waiting', '当前没有轮次 · 等待主持人开赛');
            return;
        }
        if (r.status === 'running') {
            setStatus('running', '轮次 #' + r.id + ' · ' + kindLabel(r.kind) +
                '进行中 · 剩余 ' + r.seconds_left + ' 秒');
        } else if (r.status === 'closed') {
            setStatus('closed', '轮次 #' + r.id + ' · ' + kindLabel(r.kind) + '已结算');
        } else if (r.status === 'void') {
            setStatus('waiting', '轮次 #' + r.id + ' · 已作废');
        } else {
            setStatus('waiting', '轮次 #' + r.id + ' · ' + statusLabel(r.status));
        }
    }

    function renderStats(st) {
        st = st || {};
        text(el.statPlayers, st.players == null ? '0' : st.players);
        text(el.statCards, (st.cards_used == null ? 0 : st.cards_used) + ' / ' +
            (st.cards_total == null ? 0 : st.cards_total));
        text(el.statDraws, st.draw_count == null ? '0' : st.draw_count);
    }

    function renderRoundTop(top, kind) {
        el.roundTop.innerHTML = '';
        el.roundResult.className = '';
        if (!top.length) {
            var empty = doc.createElement('li');
            empty.textContent = '本轮没有有效成绩';
            el.roundTop.appendChild(empty);
            return;
        }
        var frag = doc.createDocumentFragment();
        for (var i = 0; i < top.length; i++) {
            var item = top[i];
            var row = doc.createElement('li');
            var no = doc.createElement('span');
            no.className = 'pill pill--muted';
            no.textContent = '第 ' + (item.rank || i + 1) + ' 名';
            var name = doc.createElement('span');
            name.className = 'grow';
            name.textContent = item.name || '未知玩家';
            var score = doc.createElement('span');
            score.className = 'num';
            score.textContent = kind === 'quiz'
                ? (item.score || 0) + ' 题正确'
                : (item.score || 0) + ' 步';
            row.appendChild(no);
            row.appendChild(name);
            row.appendChild(score);
            frag.appendChild(row);
        }
        el.roundTop.appendChild(frag);
    }

    function openRound(kind) {
        if (!beginAction('open')) return;
        var r = state && state.round;
        if (r && r.status === 'running') {
            if (!global.confirm('轮次 #' + r.id + ' 仍在进行中。开启新轮次会先结算本轮并发奖，确定继续？')) {
                finishAction('open');
                return;
            }
        }
        var dur = clampInt(el.openDuration, 5, 3600, 45);
        setMsg(el.roundMsg, '正在开启' + kindLabel(kind) + '轮次…', null);
        api('round/open', { kind: kind, duration: dur }).then(function (d) {
            finishAction('open');
            if (!d || d.error) {
                setMsg(el.roundMsg, '开启失败：' + ((d && d.error) || '未知错误'), false);
                return;
            }
            clearRoundResult();
            setMsg(el.roundMsg, '已开启' + kindLabel(d.kind) + '轮次 #' + d.round_id +
                '，时长 ' + d.duration + ' 秒', true);
            refresh();
        });
    }

    function closeRound() {
        if (!beginAction('close')) return;
        var r = state && state.round;
        if (!r || r.status !== 'running') {
            finishAction('close');
            setMsg(el.roundMsg, '当前没有进行中的轮次', false);
            return;
        }
        if (!global.confirm('确定结束轮次 #' + r.id + ' 并结算？结算后名次锁定并自动发奖。')) {
            finishAction('close');
            return;
        }
        var kind = r.kind;
        setMsg(el.roundMsg, '正在结算…', null);
        api('round/close', { round_id: r.id }).then(function (d) {
            finishAction('close');
            if (!d || d.error) {
                setMsg(el.roundMsg, '结算失败：' + ((d && d.error) || '未知错误'), false);
                return;
            }
            setMsg(el.roundMsg, '轮次 #' + d.round_id + ' 已结算：上榜 ' + d.ranked +
                ' 人，发奖 ' + d.awarded + ' 人', true);
            renderRoundTop(d.top || [], kind);
            refresh();
        });
    }

    function voidRound() {
        if (!beginAction('void')) return;
        var r = state && state.round;
        if (!r) {
            finishAction('void');
            setMsg(el.roundMsg, '当前没有可作废的轮次', false);
            return;
        }
        if (!global.confirm('作废轮次 #' + r.id + '：将删除本轮成绩与发奖记录，确定？') ||
            !global.confirm('再次确认：作废后无法恢复，确定作废轮次 #' + r.id + '？')) {
            finishAction('void');
            return;
        }
        setMsg(el.roundMsg, '正在作废…', null);
        api('round/void', { round_id: r.id }).then(function (d) {
            finishAction('void');
            if (!d || d.error) {
                setMsg(el.roundMsg, '作废失败：' + ((d && d.error) || '未知错误'), false);
                return;
            }
            setMsg(el.roundMsg, '轮次 #' + r.id + ' 已作废' +
                (d.cards_returned ? '，收回刮刮乐 ' + d.cards_returned + ' 张' : ''), true);
            clearRoundResult();
            refresh();
        });
    }

    /* ------------------------------------------------------------ 参数 */
    function fillSettings(s) {
        if (settingsFilled || !s) return;
        el.setTopN.value = s.top_n == null ? 10 : s.top_n;
        el.setDuration.value = s.duration == null ? 45 : s.duration;
        el.setTarget.value = s.target_steps == null ? 480 : s.target_steps;
        el.setGift.value = s.gift_total == null ? 20 : s.gift_total;
        el.setRate.value = s.max_rate == null ? 14 : s.max_rate;
        el.openDuration.value = s.duration == null ? 45 : s.duration;
        settingsFilled = true;
    }

    function saveSettings() {
        var payload = {
            top_n: clampInt(el.setTopN, 1, 200, 10),
            duration: clampInt(el.setDuration, 5, 3600, 45),
            target_steps: clampInt(el.setTarget, 10, 5000, 480),
            gift_total: clampInt(el.setGift, 0, 1000, 20),
            max_rate: clampInt(el.setRate, 1, 60, 14)
        };
        setMsg(el.settingsMsg, '正在保存…', null);
        api('settings', { settings: payload }).then(function (d) {
            if (!d || d.error) {
                setMsg(el.settingsMsg, '保存失败：' + ((d && d.error) || '未知错误'), false);
                return;
            }
            var n = 0;
            var changed = d.changed || {};
            for (var k in changed) {
                if (Object.prototype.hasOwnProperty.call(changed, k)) n++;
            }
            setMsg(el.settingsMsg, '参数已保存' + (n ? '（' + n + ' 项）' : ''), true);
            /* 下一轮开赛的默认时长跟随保存值；主持人正在改这个输入框时不打扰 */
            if (doc.activeElement !== el.openDuration) {
                el.openDuration.value = String(payload.duration);
            }
            refresh();
        });
    }

    /* ------------------------------------------------------------ 题库 */
    function fillQuestions(list) {
        if (questionsLoaded) return;
        el.questionsJson.value = JSON.stringify(list || [], null, 2);
        text(el.qCount, '当前模板 ' + ((list && list.length) || 0) + ' 题');
        questionsLoaded = true;
    }

    function checkQuestions(list) {
        if (!list.length) return '题库至少需要 1 道题';
        for (var i = 0; i < list.length; i++) {
            var q = list[i];
            var no = '第 ' + (i + 1) + ' 题';
            if (!q || typeof q !== 'object' || isArray(q)) return no + '必须是对象';
            if (typeof q.prompt !== 'string' || !q.prompt.trim()) return no + '缺少 prompt 文本';
            if (q.qtype !== '单选' && q.qtype !== '多选') return no + '的 qtype 只能是「单选」或「多选」';
            if (!isArray(q.options) || !q.options.length) return no + '的 options 必须是非空数组';
            for (var j = 0; j < q.options.length; j++) {
                if (typeof q.options[j] !== 'string' || !q.options[j]) {
                    return no + '的 options[' + j + '] 必须是非空文本';
                }
            }
            if (typeof q.answer === 'string') {
                if (!q.answer) return no + '缺少 answer 文本';
            } else if (isArray(q.answer)) {
                if (!q.answer.length) return no + '的 answer 数组不能为空';
                for (var m = 0; m < q.answer.length; m++) {
                    if (typeof q.answer[m] !== 'string' || !q.answer[m]) {
                        return no + '的 answer[' + m + '] 必须是非空文本';
                    }
                }
            } else {
                return no + '的 answer 必须是文本或文本数组';
            }
        }
        return '';
    }

    function saveQuestions() {
        var raw = String(el.questionsJson.value || '');
        if (!raw.trim()) {
            setMsg(el.questionsMsg, '题库不能为空，请粘贴 JSON 数组', false);
            return;
        }
        var list;
        try {
            list = JSON.parse(raw);
        } catch (e) {
            setMsg(el.questionsMsg, 'JSON 解析失败：' + e.message, false);
            return;
        }
        if (!isArray(list)) {
            setMsg(el.questionsMsg, '题库必须是数组，例如 [{ "prompt": "...", "qtype": "单选", ... }]', false);
            return;
        }
        var problem = checkQuestions(list);
        if (problem) {
            setMsg(el.questionsMsg, problem, false);
            return;
        }
        setMsg(el.questionsMsg, '正在保存…', null);
        api('questions', { questions: list }).then(function (d) {
            if (!d || d.error) {
                setMsg(el.questionsMsg, '保存失败：' + ((d && d.error) || '未知错误'), false);
                return;
            }
            var count = d.count == null ? list.length : d.count;
            el.questionsJson.value = JSON.stringify(list, null, 2);
            text(el.qCount, '当前模板 ' + count + ' 题');
            setMsg(el.questionsMsg, '题库已保存，共 ' + count + ' 题；下一轮答题生效', true);
            refresh();
        });
    }

    /* ------------------------------------------------------------ 奖品 */
    function cellInput(type, field, value, min, max) {
        var td = doc.createElement('td');
        var input = doc.createElement('input');
        input.type = type;
        input.setAttribute('data-field', field);
        if (type === 'number') {
            input.min = String(min == null ? 0 : min);
            input.max = String(max == null ? 9999 : max);
            input.step = '1';
            input.setAttribute('inputmode', 'numeric');
        }
        input.value = value == null ? '' : String(value);
        td.appendChild(input);
        return td;
    }

    function prizeRow(p) {
        var tr = doc.createElement('tr');
        tr.setAttribute('data-id', String(p.id));
        tr.appendChild(cellInput('text', 'name', p.name || ''));
        tr.appendChild(cellInput('number', 'stock_total', p.stock_total, 0, 999));
        tr.appendChild(cellInput('number', 'per_kind_limit', p.per_kind_limit, 0, 999));
        var used = doc.createElement('td');
        used.setAttribute('data-used', '1');
        used.textContent = String(p.used == null ? 0 : p.used);
        tr.appendChild(used);
        var enableTd = doc.createElement('td');
        var box = doc.createElement('input');
        box.type = 'checkbox';
        box.setAttribute('data-field', 'enabled');
        box.checked = !!p.enabled;
        enableTd.appendChild(box);
        tr.appendChild(enableTd);
        return tr;
    }

    function buildPrizes(list) {
        el.prizesBody.innerHTML = '';
        prizesBuilt = true;
        if (!list || !list.length) {
            recalcPrizeTotal();
            return;
        }
        var frag = doc.createDocumentFragment();
        for (var i = 0; i < list.length; i++) {
            frag.appendChild(prizeRow(list[i]));
        }
        el.prizesBody.appendChild(frag);
        recalcPrizeTotal();
    }

    function updatePrizeUsed(list) {
        if (!prizesBuilt || !list) return;
        for (var i = 0; i < list.length; i++) {
            var row = el.prizesBody.querySelector('tr[data-id="' + String(list[i].id) + '"]');
            if (!row) continue;
            var cell = row.querySelector('td[data-used]');
            if (cell) cell.textContent = String(list[i].used == null ? 0 : list[i].used);
        }
        recalcPrizeTotal();
    }

    /* 预计最多可发 = Σ min(总库存, 每人上限)，只统计勾选启用的奖品 */
    function recalcPrizeTotal() {
        if (!prizesBuilt) {
            text(el.prizeTotal, '预计最多可发 0 人');
            return;
        }
        var total = 0;
        var rows = el.prizesBody.rows;
        for (var i = 0; i < rows.length; i++) {
            var box = rows[i].querySelector('input[data-field="enabled"]');
            if (!box || !box.checked) continue;
            var stock = Math.max(0, intVal(rows[i].querySelector('input[data-field="stock_total"]'), 0));
            var limit = Math.max(0, intVal(rows[i].querySelector('input[data-field="per_kind_limit"]'), 0));
            total += Math.min(stock, limit);
        }
        text(el.prizeTotal, '预计最多可发 ' + total + ' 人');
    }

    function collectPrizes() {
        var out = [];
        var rows = el.prizesBody.rows;
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var nameNode = row.querySelector('input[data-field="name"]');
            var stockNode = row.querySelector('input[data-field="stock_total"]');
            var limitNode = row.querySelector('input[data-field="per_kind_limit"]');
            var box = row.querySelector('input[data-field="enabled"]');
            var name = String(nameNode && nameNode.value || '').trim();
            out.push({
                id: parseInt(row.getAttribute('data-id'), 10) || 0,
                name: name || '奖品',
                stock_total: Math.max(0, intVal(stockNode, 0)),
                per_kind_limit: Math.max(0, intVal(limitNode, 0)),
                enabled: !!(box && box.checked),
                sort_no: i
            });
        }
        return out;
    }

    function savePrizes() {
        if (!prizesBuilt) {
            setMsg(el.prizesMsg, '奖品表尚未加载完成，请稍候', false);
            return;
        }
        var list = collectPrizes();
        if (!list.length) {
            setMsg(el.prizesMsg, '没有可保存的奖品', false);
            return;
        }
        setMsg(el.prizesMsg, '正在保存…', null);
        api('prizes', { prizes: list }).then(function (d) {
            if (!d || d.error) {
                setMsg(el.prizesMsg, '保存失败：' + ((d && d.error) || '未知错误'), false);
                return;
            }
            setMsg(el.prizesMsg, '奖品设置已保存', true);
            refresh();
        });
    }

    /* ------------------------------------------------------------ 领奖核销 */
    function appendCell(tr, value) {
        var td = doc.createElement('td');
        td.textContent = value == null ? '' : String(value);
        tr.appendChild(td);
        return td;
    }

    function claimBtn(label, kind, reward, done) {
        var btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'btn';
        btn.textContent = done ? ('已核销' + (kind === 'card' ? '刮刮乐' : '礼物')) : label;
        btn.setAttribute('data-kind', kind);
        btn.setAttribute('data-round', String(reward.round_id));
        btn.setAttribute('data-player', reward.player_id);
        btn.setAttribute('data-name', reward.name || '');
        btn.disabled = done;
        return btn;
    }

    function rewardRow(r) {
        var tr = doc.createElement('tr');
        appendCell(tr, '#' + r.round_id);
        appendCell(tr, r.rank == null ? '—' : r.rank);
        appendCell(tr, r.name || '未知玩家');
        appendCell(tr, r.card_no || '—');
        appendCell(tr, r.gift ? '1 份' : '—');

        var st = doc.createElement('td');
        var cardPill = doc.createElement('span');
        cardPill.className = 'pill ' + (r.claimed_at ? 'pill--done' : 'pill--wait');
        cardPill.textContent = r.claimed_at ? '刮刮乐已核销' : '刮刮乐未核销';
        var giftPill = doc.createElement('span');
        giftPill.className = 'pill ' + (r.gift_claimed_at ? 'pill--done' : 'pill--wait');
        giftPill.textContent = r.gift_claimed_at ? '礼物已核销' : '礼物未核销';
        st.appendChild(cardPill);
        st.appendChild(giftPill);
        tr.appendChild(st);

        var ops = doc.createElement('td');
        var box = doc.createElement('div');
        box.className = 'admin-actions';
        box.appendChild(claimBtn('核销刮刮乐', 'card', r, !!r.claimed_at));
        box.appendChild(claimBtn('核销礼物', 'gift', r, !r.gift || !!r.gift_claimed_at));
        ops.appendChild(box);
        tr.appendChild(ops);
        return tr;
    }

    function rewardsSignature(list) {
        return JSON.stringify((list || []).map(function (r) {
            return [r.round_id, r.player_id, r.rank, r.name, r.card_no, r.gift,
                    r.claimed_at || '', r.gift_claimed_at || ''];
        }));
    }

    function renderRewards(list) {
        /* 轮询重建会把正在点的核销按钮从 DOM 里摘掉；数据没变就不重建 */
        var sig = rewardsSignature(list);
        if (sig === rewardsSig) return;
        rewardsSig = sig;
        el.rewardsBody.innerHTML = '';
        if (!list || !list.length) {
            var tr = doc.createElement('tr');
            var td = doc.createElement('td');
            td.colSpan = 7;
            td.textContent = '暂无发奖记录 · 结束轮次后自动生成';
            tr.appendChild(td);
            el.rewardsBody.appendChild(tr);
            return;
        }
        var frag = doc.createDocumentFragment();
        for (var i = 0; i < list.length; i++) {
            frag.appendChild(rewardRow(list[i]));
        }
        el.rewardsBody.appendChild(frag);
    }

    function onRewardsClick(e) {
        var node = e.target;
        while (node && node !== el.rewardsBody && node.nodeName !== 'BUTTON') {
            node = node.parentNode;
        }
        if (!node || node.nodeName !== 'BUTTON' || node.disabled) return;
        var kind = node.getAttribute('data-kind');
        var roundId = parseInt(node.getAttribute('data-round'), 10) || 0;
        var playerId = node.getAttribute('data-player') || '';
        var who = node.getAttribute('data-name') || '该玩家';
        if (!roundId || !playerId) return;
        node.disabled = true;
        setMsg(el.claimMsg, '正在核销…', null);
        api('claim', {
            round_id: roundId,
            player_id: playerId,
            kind: kind
        }).then(function (d) {
            if (!d || d.error) {
                node.disabled = false;
                setMsg(el.claimMsg, '核销失败：' + ((d && d.error) || '未知错误'), false);
                return;
            }
            setMsg(el.claimMsg, who + ' 的' + (kind === 'card' ? '刮刮乐' : '小礼物') + '已核销', true);
            refresh();
        });
    }

    /* ------------------------------------------------------------ 抽奖 */
    function renderBalls(balls) {
        var keys = ['百位', '十位', '个位'];
        el.drawBalls.innerHTML = '';
        for (var i = 0; i < keys.length; i++) {
            var span = doc.createElement('span');
            span.appendChild(doc.createTextNode(keys[i]));
            var b = doc.createElement('b');
            b.textContent = balls && balls[keys[i]] != null ? String(balls[keys[i]]) : '?';
            span.appendChild(b);
            el.drawBalls.appendChild(span);
        }
    }

    function ballsFrom(no) {
        var s = String(no || '');
        if (s.length !== 3) return null;
        return { '百位': s.charAt(0), '十位': s.charAt(1), '个位': s.charAt(2) };
    }

    function drawNumber() {
        if (!beginAction('number')) return;
        setMsg(el.drawMsg, '正在抽号…', null);
        api('draw/number', {}).then(function (d) {
            finishAction('number');
            if (!d || d.error) {
                setMsg(el.drawMsg, '抽号失败：' + ((d && d.error) || '未知错误'), false);
                return;
            }
            text(el.drawNumber, d.card_no);
            el.drawNumber.className = 'num-big';
            renderBalls(d.balls || ballsFrom(d.card_no));
            text(el.drawPlayer, '持卡人：' + (d.player || '未知'));
            el.drawCard.value = d.card_no || '';
            text(el.drawPrize, '待开奖');
            setMsg(el.drawMsg, '已抽中编号 ' + d.card_no + '，可直接开奖', true);
            refresh();
        });
    }

    function spin() {
        var no = String(el.drawCard.value || '').replace(/\s+/g, '');
        if (!/^[0-9]{3}$/.test(no)) {
            setMsg(el.drawMsg, '请输入三位刮刮乐编号，例如 038', false);
            return;
        }
        if (!beginAction('spin')) return;
        setMsg(el.drawMsg, '正在开奖…', null);
        api('draw/spin', { card_no: no }).then(function (d) {
            finishAction('spin');
            if (!d || d.error) {
                setMsg(el.drawMsg, '开奖失败：' + ((d && d.error) || '未知错误'), false);
                return;
            }
            text(el.drawNumber, d.card_no);
            el.drawNumber.className = 'num-big';
            renderBalls(ballsFrom(d.card_no));
            text(el.drawPlayer, '持卡人：' + (d.player || '未知'));
            text(el.drawPrize, d.prize || '—');
            setMsg(el.drawMsg, '编号 ' + d.card_no + ' 开奖成功：' + d.prize +
                (d.prize_id == null ? '' : '（奖品编号 ' + d.prize_id + '）'), true);
            refresh();
        });
    }

    function resetDraws() {
        if (!global.confirm('清空全部抽奖记录？所有编号将回到未抽状态，确定？')) return;
        if (!global.confirm('再次确认：抽奖记录清空后不可恢复，确定清空？')) return;
        setMsg(el.drawMsg, '正在清空…', null);
        api('draw/reset', {}).then(function (d) {
            if (!d || d.error) {
                setMsg(el.drawMsg, '清空失败：' + ((d && d.error) || '未知错误'), false);
                return;
            }
            resetDrawDisplay();
            setMsg(el.drawMsg, '抽奖记录已清空', true);
            refresh();
        });
    }

    function renderDrawHistory(list) {
        el.drawHistory.innerHTML = '';
        if (!list || !list.length) {
            var empty = doc.createElement('li');
            empty.textContent = '暂无抽奖记录';
            el.drawHistory.appendChild(empty);
            return;
        }
        var frag = doc.createDocumentFragment();
        var n = Math.min(list.length, 20);
        for (var i = 0; i < n; i++) {
            var d = list[i];
            var row = doc.createElement('li');
            var no = doc.createElement('span');
            no.className = 'pill pill--done';
            no.textContent = d.card_no || '---';
            var who = doc.createElement('span');
            who.className = 'grow';
            who.textContent = (d.player || '未知玩家') + (d.prize ? ' · ' + d.prize : ' · 待开奖');
            var at = doc.createElement('span');
            at.className = 'muted';
            at.textContent = clock(d.drawn_at);
            row.appendChild(no);
            row.appendChild(who);
            row.appendChild(at);
            frag.appendChild(row);
        }
        el.drawHistory.appendChild(frag);
    }

    /* ------------------------------------------------------------ 审计 */
    function renderAudit(list) {
        el.auditList.innerHTML = '';
        if (!list || !list.length) {
            var empty = doc.createElement('li');
            empty.textContent = '暂无操作记录';
            el.auditList.appendChild(empty);
            return;
        }
        var frag = doc.createDocumentFragment();
        var n = Math.min(list.length, 30);
        for (var i = 0; i < n; i++) {
            var a = list[i];
            var row = doc.createElement('li');
            var at = doc.createElement('span');
            at.className = 'pill pill--muted';
            at.textContent = clock(a.at);
            var act = doc.createElement('b');
            act.textContent = ACTION_LABEL[a.action] || a.action || '操作';
            var detail = doc.createElement('span');
            detail.className = 'grow muted';
            detail.textContent = a.detail || '';
            row.appendChild(at);
            row.appendChild(act);
            row.appendChild(detail);
            frag.appendChild(row);
        }
        el.auditList.appendChild(frag);
    }

    /* ------------------------------------------------------------ 状态应用 / 轮询 */
    function applyState(s) {
        state = s;
        renderRound(s);
        renderStatusBar(s);
        renderStats(s.stats);
        renderRewards(s.rewards);
        renderDrawHistory(s.draws);
        renderAudit(s.audit);
        updatePrizeUsed(s.prizes);
        /* 三个编辑区只在登录后第一次填充，轮询绝不覆盖主持人正在编辑的内容 */
        if (!settingsFilled) fillSettings(s.settings);
        if (!questionsLoaded) fillQuestions(s.questions);
        if (!prizesBuilt) buildPrizes(s.prizes);
    }

    function refresh() {
        if (!loggedIn) return;
        if (inflight) {
            pending = true;
            return;
        }
        inflight = true;
        global.PG.Net.adminState().then(function (s) {
            inflight = false;
            if (!loggedIn) return;
            if (!s) {
                failCount++;
                setStatus('offline', '状态刷新中断 · 已重试 ' + failCount + ' 次（编辑内容不会被清空）');
                runPending();
                return;
            }
            failCount = 0;
            applyState(s);
            runPending();
        }).catch(function () {
            inflight = false;
            if (!loggedIn) return;
            failCount++;
            setStatus('error', '状态刷新失败 · 已重试 ' + failCount + ' 次（编辑内容不会被清空）');
            runPending();
        });
    }

    function runPending() {
        if (pending) {
            pending = false;
            refresh();
        }
    }

    function startPolling() {
        stopPolling();
        refresh();
        pollTimer = global.setInterval(refresh, POLL_MS);
    }

    function stopPolling() {
        if (pollTimer) {
            global.clearInterval(pollTimer);
            pollTimer = 0;
        }
    }

    function showConsole(s) {
        loggedIn = true;
        failCount = 0;
        setView('console');
        setStatus('waiting', '已登录 · 正在读取状态…');
        applyState(s);
        startPolling();
    }

    function endSession(msg, ok) {
        loggedIn = false;
        inflight = false;
        pending = false;
        failCount = 0;
        stopPolling();
        global.PG.Net.adminLogout();
        resetConsole();
        setView('login');
        setMsg(el.loginMsg, msg || '', ok);
        setStatus('waiting', '未登录 · 请输入管理口令');
    }

    /* ------------------------------------------------------------ 登录 / 恢复 */
    function login() {
        if (el.btnLogin.disabled) return;
        var pwd = String(el.adminPassword.value || '');
        if (!pwd) {
            setMsg(el.loginMsg, '请输入管理口令', false);
            return;
        }
        sessionSeq++;   /* 手动登录优先：启动时发出的恢复请求此后视为过期 */
        el.btnLogin.disabled = true;
        setMsg(el.loginMsg, '正在验证口令…', null);
        global.PG.Net.adminLogin(pwd).then(function (d) {
            el.adminPassword.value = '';
            if (!d || d.error) {
                el.btnLogin.disabled = false;
                setStatus('waiting', '未登录 · 请输入管理口令');
                setMsg(el.loginMsg, '登录失败：' + ((d && d.error) || '未知错误'), false);
                return;
            }
            return global.PG.Net.adminState().then(function (s) {
                el.btnLogin.disabled = false;
                if (!s) {
                    global.PG.Net.adminLogout();
                    setStatus('waiting', '未登录 · 请输入管理口令');
                    setMsg(el.loginMsg, '登录已失效，请重试', false);
                    return;
                }
                setMsg(el.loginMsg, '');
                showConsole(s);
            });
        }).catch(function () {
            el.btnLogin.disabled = false;
            el.adminPassword.value = '';
            setStatus('waiting', '未登录 · 请输入管理口令');
            setMsg(el.loginMsg, '登录失败：网络异常', false);
        });
    }

    function resume() {
        if (!hasSavedToken()) {
            setStatus('waiting', '未登录 · 请输入管理口令');
            return;
        }
        var seq = sessionSeq;
        setStatus('waiting', '正在恢复登录状态…');
        global.PG.Net.adminState().then(function (s) {
            /* 主持人已手动登录（sessionSeq 推进）时，迟到的恢复结果直接丢弃，
               绝不能对刚建立的新会话执行 adminLogout */
            if (seq !== sessionSeq || loggedIn) return;
            if (s) {
                showConsole(s);
                return;
            }
            global.PG.Net.adminLogout();
            setStatus('waiting', '未登录 · 请输入管理口令');
            setMsg(el.loginMsg, '登录已失效，请重新输入口令', false);
        });
    }

    /* ------------------------------------------------------------ 事件绑定 */
    function bindEvents() {
        el.btnLogin.addEventListener('click', login);
        el.adminPassword.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.keyCode === 13) {
                e.preventDefault();
                login();
            }
        });
        el.btnLogout.addEventListener('click', function () {
            endSession('已退出登录', null);
        });
        el.btnOpenShake.addEventListener('click', function () { openRound('shake'); });
        el.btnOpenQuiz.addEventListener('click', function () { openRound('quiz'); });
        el.btnCloseRound.addEventListener('click', closeRound);
        el.btnVoidRound.addEventListener('click', voidRound);
        el.btnSaveSettings.addEventListener('click', saveSettings);
        el.btnSaveQuestions.addEventListener('click', saveQuestions);
        el.btnSavePrizes.addEventListener('click', savePrizes);
        el.btnDrawNumber.addEventListener('click', drawNumber);
        el.btnSpin.addEventListener('click', spin);
        el.btnDrawReset.addEventListener('click', resetDraws);
        el.drawCard.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.keyCode === 13) {
                e.preventDefault();
                spin();
            }
        });
        el.prizesBody.addEventListener('input', recalcPrizeTotal);
        el.prizesBody.addEventListener('change', recalcPrizeTotal);
        el.rewardsBody.addEventListener('click', onRewardsClick);
    }

    /* ------------------------------------------------------------ 启动 */
    function boot() {
        cacheEls();
        mountIcons();
        bindEvents();
        setView('login');
        setStatus('waiting', '正在连接晚会服务端…');

        global.PG.Net.detect().then(function (mode) {
            if (mode !== 'online') {
                text(el.modeBadge, '未连接');
                el.modeBadge.className = 'plate plate--quiet';
                setStatus('offline', '未连接晚会服务端 · 请先运行 python server.py');
                setMsg(el.loginMsg, '未连接晚会服务端，无法登录控制台', false);
                el.btnLogin.disabled = true;
                return;
            }
            text(el.modeBadge, '服务端已连接');
            el.modeBadge.className = 'plate plate--online';
            resume();
        });
    }

    if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})(window);