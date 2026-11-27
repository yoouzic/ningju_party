/* ==========================================================================
   ui.js —— DOM 层：标签页 / 登录 / HUD / 弹层 / 榜单 / 摇一摇授权 / 按钮绑定
   通过 hooks 与 Game 通信，Game 不直接碰 DOM
   ========================================================================== */
(function (global) {
    'use strict';
    var PG = global.PG = global.PG || {};
    var C = PG.CONFIG, U = PG.Utils, R = PG.Rules, A = PG.Audio, ST = PG.Storage;
    var PHASE = PG.PHASE;
    var CARET = '<span class="caret" aria-hidden="true">▶</span>';

    function $(id) { return global.document.getElementById(id); }
    function show(el, yes) { if (el) el.classList.toggle('hidden', !yes); }
    function retrigger(el, cls) {
        el.classList.remove(cls);
        void el.offsetWidth;
        el.classList.add(cls);
    }

    PG.UI = {
        init: function (game) {
            var doc = global.document;
            var el = {
                canvas: $('game-canvas'), view: $('screen-view'), console: $('console'), stateText: $('state-text'),
                score: $('hud-score'), time: $('hud-time'), combo: $('hud-combo'),
                rank: $('hud-rank'), lives: $('hud-lives'), gifts: $('hud-gifts'),
                progress: $('hud-progress'), energy: $('hud-energy'),
                barProgress: $('bar-progress'), barEnergy: $('bar-energy'),
                barProgressWrap: $('bar-progress-wrap'), barEnergyWrap: $('bar-energy-wrap'),
                ovReady: $('overlay-ready'), ovCount: $('overlay-countdown'),
                ovPaused: $('overlay-paused'), ovOver: $('overlay-over'),
                countText: $('countdown-text'), toast: $('stage-toast'), fever: $('fever-flag'),
                ribbon: $('result-ribbon'), resultTitle: $('result-title'),
                resultDesc: $('result-desc'), resultStats: $('result-stats'),
                leaderboard: $('leaderboard'), best: $('best-record'),
                playerName: $('player-name'), playerCode: $('player-code'),
                playerCard: $('player-card'), partyState: $('party-state'),
                headerPlayer: $('header-player'), modeBadge: $('mode-badge'), boardNote: $('board-note'),
                readyForm: $('ready-form'), readyWait: $('ready-wait'),
                readyTab: $('ready-tab'), readyTitle: $('ready-title'),
                waitName: $('wait-name'), waitCard: $('wait-card'), waitText: $('wait-text'),
                startInlineLabel: $('start-inline-label'), againLabel: $('again-label'),
                resultNote: $('result-note'),
                bPrimary: $('btn-primary'), bStartInline: $('btn-start-inline'),
                bPause: $('btn-pause'), bRestart: $('btn-restart'),
                bSound: $('btn-sound'), bShake: $('btn-shake'), bShakeStart: $('btn-shake-start'),
                bShakeWait: $('btn-shake-wait'), bChangePlayer: $('btn-change-player'),
                bResume: $('btn-resume'), bPauseRestart: $('btn-pause-restart'),
                bAgain: $('btn-again')
            };

            /* 正式模式状态：online 由 onMode 决定，loggedIn 表示已拿到服务端 token */
            var online = false;
            var loggedIn = !!PG.Net.getPlayer();
            var waiting = false;

            /* 像素图标挂载 */
            var icons = doc.querySelectorAll('[data-icon]');
            for (var n = 0; n < icons.length; n++) {
                var node = icons[n];
                PG.Sprites.mount(node, node.getAttribute('data-icon'), parseInt(node.getAttribute('data-scale') || '2', 10));
            }

            /* -------------------------------------------------------- 标签页（键盘左右可切换） */
            var tabs = Array.prototype.slice.call(doc.querySelectorAll('.tab'));
            function selectTab(tab, focus) {
                for (var i = 0; i < tabs.length; i++) {
                    var on = tabs[i] === tab;
                    tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
                    tabs[i].tabIndex = on ? 0 : -1;
                    var pane = doc.getElementById(tabs[i].getAttribute('aria-controls'));
                    if (pane) pane.hidden = !on;
                }
                if (focus) tab.focus();
            }
            var tablist = doc.querySelector('.tablist') || doc.querySelector('[role="tablist"]');
            for (var ti = 0; ti < tabs.length; ti++) {
                tabs[ti].addEventListener('click', (function (t) { return function () { selectTab(t, false); }; })(tabs[ti]));
            }
            if (tablist) {
                tablist.addEventListener('keydown', function (e) {
                    var idx = tabs.indexOf(doc.activeElement);
                    if (idx < 0) return;
                    var next = -1;
                    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
                    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
                    else if (e.key === 'Home') next = 0;
                    else if (e.key === 'End') next = tabs.length - 1;
                    if (next >= 0) { e.preventDefault(); e.stopPropagation(); selectTab(tabs[next], true); }
                });
            }

            /* -------------------------------------------------------- 登录身份 */
            var saved = PG.Net.getPlayer();
            if (el.playerName && saved && saved.name) el.playerName.value = saved.name;
            if (el.playerCode && saved && saved.code) el.playerCode.value = saved.code;
            function syncIdentity(p) {
                el.headerPlayer.textContent = p && p.name ? p.name : '未登录';
                var card = '刮刮乐编号：' + (p && p.card_no ? p.card_no : '---');
                el.playerCard.textContent = card;
                el.waitCard.textContent = card;
                el.waitName.textContent = p && p.name ? p.name : '—';
            }
            syncIdentity(saved);

            /* 正式模式登录后停在「等待开赛」，不能再自行开局；练习模式保留原按钮 */
            function setWaiting(on) {
                waiting = !!on;
                show(el.readyForm, !waiting);
                show(el.readyWait, waiting);
                el.readyTab.textContent = waiting ? 'WAITING' : 'READY';
                el.readyTab.className = 'dialog__tab ' + (waiting ? 'tab--blue' : 'tab--pink');
                el.readyTitle.textContent = waiting ? '已登录 · 等待开赛' : '摇一摇 像素冲刺';
                var label = online ? '登录并进入晚会' : '开始游戏';
                el.startInlineLabel.textContent = label;
                if (game.s.phase === PHASE.READY) {
                    if (waiting) { el.bPrimary.textContent = '等待开赛'; el.bPrimary.disabled = true; }
                    else { setPrimary(CARET + label); el.bPrimary.disabled = false; }
                }
            }

            function setPartyBar(kind, text) {
                var cls = 'party-bar ';
                if (kind === 'running') cls += 'party-bar--running';
                else if (kind === 'closed' || kind === 'idle') cls += 'party-bar--closed';
                else if (kind === 'practice' || kind === 'error') cls += 'party-bar--offline';
                else cls += 'party-bar--waiting';
                if (kind === 'error') cls += ' party-bar--error';
                el.partyState.className = cls;
                el.partyState.textContent = text;
            }

            function begin() {
                A.init();
                var name = el.playerName ? el.playerName.value : '';
                var code = el.playerCode ? el.playerCode.value : '';
                PG.Net.join(name, code).then(function (d) {
                    syncIdentity(d.player);
                    if (PG.Net.isOnline()) {
                        loggedIn = true;
                        setWaiting(true);
                        toast('登录成功 · 等待主持人开赛');
                        doc.dispatchEvent(new Event('ningju:joined'));
                    } else {
                        loggedIn = false;
                        setWaiting(false);
                        game.confirm();
                    }
                }).catch(function (e) {
                    toast('登录失败：' + (e && e.message ? e.message : '请重试'));
                });
            }

            function resetLocal() {
                A.init();
                if (online) game.waitReset();     /* 正式模式不开本地倒计时 */
                else game.restart();
            }

            /* -------------------------------------------------------- HUD */
            var hudClock = -1, lastScore = -1;
            function updateHUD(s) {
                /* reset() 会把 s.time 归零，必须重置节流时钟，否则重开后 HUD 会停更 */
                if (hudClock >= 0 && s.time < hudClock) hudClock = -1;
                if (hudClock >= 0 && s.time - hudClock < 0.08) return;
                hudClock = s.time;
                el.score.textContent = U.group(s.score);
                if (lastScore !== s.score) { retrigger(el.score, 'flash'); lastScore = s.score; }
                el.time.textContent = U.fmtTime(s.timeLeft);
                el.time.classList.toggle('is-low', s.phase === PHASE.PLAYING && s.timeLeft <= 10);
                el.combo.textContent = String(s.combo);
                el.rank.textContent = s.rank ? '#' + s.rank : '--';
                el.lives.textContent = new Array(s.lives + 1).join('♥') + new Array(C.LIVES - s.lives + 1).join('♡');
                el.gifts.textContent = String(Math.floor(s.gifts / C.GIFTS_PER_CARD));

                var pg = Math.min(100, s.progress);
                el.barProgress.style.width = pg.toFixed(1) + '%';
                el.progress.textContent = Math.floor(pg) + '%';
                el.barProgressWrap.setAttribute('aria-valuenow', String(Math.floor(pg)));

                var fever = s.fever > 0;
                var eg = fever ? 100 : s.energy;
                el.barEnergy.style.width = eg.toFixed(1) + '%';
                el.barEnergy.classList.toggle('is-fever', fever);
                el.energy.textContent = fever ? 'FEVER' : Math.floor(eg) + '%';
                el.energy.classList.toggle('is-fever', fever);
                el.barEnergyWrap.setAttribute('aria-valuenow', String(Math.floor(eg)));
            }

            /* -------------------------------------------------------- 榜单 / 记录 */
            var serverEntries = null;
            var myId = (PG.Net.getPlayer() || {}).id || '';

            function boardHtml(rows) {
                var html = '';
                for (var i = 0; i < rows.length; i++) {
                    var r = rows[i];
                    var cls = [];
                    if (r.rank <= 3) cls.push('top' + r.rank);
                    if (r.isPlayer || (myId && r.player_id === myId)) cls.push('is-player');
                    if (r.cut) cls.push('cut');
                    var score = r.score === undefined ? r.correct || 0 : r.score;
                    html += '<li class="' + cls.join(' ') + '">' +
                        '<span class="rank__no">' + U.pad2(r.rank) + '</span>' +
                        '<span class="rank__name">' + r.name + '</span>' +
                        '<span class="rank__score">' + U.group(score) + '</span></li>';
                }
                return html;
            }
            function renderBoard(playerScore) {
                var rows;
                if (PG.Net.isOnline()) {
                    rows = (serverEntries || []).slice(0, 10);
                } else {
                    rows = R.boardRows(playerScore);
                }
                el.leaderboard.innerHTML = rows.length
                    ? boardHtml(rows)
                    : '<li class="ranks__empty">还没有成绩，等待主持人开赛</li>';
            }
            function refreshBoard(entries) {
                serverEntries = entries || [];
                myId = (PG.Net.getPlayer() || {}).id || '';
                renderBoard(0);
            }

            function renderRecord(rec) {
                if (!rec.plays) {
                    el.best.innerHTML = '<p class="records__empty">还没有战绩，跑完第一局就会记录在这里</p>';
                    return;
                }
                var rows = [
                    ['游玩次数', rec.plays + ' 局'],
                    ['最高竞速积分', U.group(rec.bestRaceScore)],
                    ['最佳名次', rec.bestRank ? '第 ' + rec.bestRank + ' 名' : '—'],
                    ['最快完赛', rec.bestTime ? rec.bestTime.toFixed(1) + ' 秒' : '—'],
                    ['最高连击', rec.bestCombo + ' HIT'],
                    ['晋级次数', rec.wins + ' 次'],
                    ['累计刮刮乐', rec.totalCards + ' 张']
                ];
                var html = '';
                for (var i = 0; i < rows.length; i++) {
                    html += '<div><span>' + rows[i][0] + '</span><b>' + rows[i][1] + '</b></div>';
                }
                el.best.innerHTML = html;
            }

            /* -------------------------------------------------------- 弹层与外壳状态 */
            function setPrimary(html) { el.bPrimary.innerHTML = html; }

            function showPhase(phase) {
                show(el.ovReady, phase === PHASE.READY);
                show(el.ovCount, phase === PHASE.COUNTDOWN);
                show(el.ovPaused, phase === PHASE.PAUSED);
                show(el.ovOver, phase === PHASE.OVER);
                show(el.fever, false);
                el.console.setAttribute('data-state', phase);

                if (phase === PHASE.READY) {
                    el.stateText.textContent = '待机';
                    setWaiting(online && loggedIn);
                    el.bPause.disabled = true; el.bPause.textContent = '暂停';
                    el.bRestart.disabled = true;
                } else if (phase === PHASE.COUNTDOWN) {
                    el.stateText.textContent = '倒计时';
                    el.bPrimary.textContent = '准备中'; el.bPrimary.disabled = true;
                    el.bPause.disabled = true; el.bRestart.disabled = false;
                } else if (phase === PHASE.PLAYING) {
                    el.stateText.textContent = '进行中';
                    el.bPrimary.textContent = '进行中'; el.bPrimary.disabled = true;
                    el.bPause.disabled = false; el.bPause.textContent = '暂停';
                    el.bRestart.disabled = false;
                } else if (phase === PHASE.PAUSED) {
                    el.stateText.textContent = '已暂停';
                    setPrimary(CARET + '继续游戏'); el.bPrimary.disabled = false;
                    el.bPause.disabled = false; el.bPause.textContent = '继续';
                    el.bRestart.disabled = false;
                } else if (phase === PHASE.OVER) {
                    el.stateText.textContent = '已结算';
                    setPrimary(CARET + (online ? '返回等待' : '再来一局')); el.bPrimary.disabled = false;
                    el.bPause.disabled = true; el.bPause.textContent = '暂停';
                    el.bRestart.disabled = false;
                }
            }

            function setCountdown(value) {
                el.countText.textContent = value;
                el.countText.style.animation = 'none';
                void el.countText.offsetWidth;
                el.countText.style.animation = '';
            }
            function toast(text) {
                el.toast.textContent = text;
                retrigger(el.toast, 'show');
            }
            function shake() {
                retrigger(el.view, 'shake');
                global.setTimeout(function () { el.view.classList.remove('shake'); }, 320);
            }

            function showResult(result, record) {
                var v = R.verdict(result);
                el.ribbon.textContent = result.practice ? 'PRACTICE' :
                    (result.pending ? 'WAITING' : v.ribbon);
                el.ribbon.className = 'dialog__tab ' + (result.practice || result.pending ? 'tab--blue' : v.cls);
                el.resultTitle.textContent = result.practice ? '练习完成' :
                    (result.pending ? '等待主持人结算' : v.title);
                el.resultDesc.textContent = result.practice
                    ? '练习模式成绩不计入晚会榜单，正式环节请连接晚会服务端。'
                    : (result.pending
                        ? '本环节由主持人结束后统一锁定前 10 名，请查看大屏榜单领奖。'
                        : v.desc);
                var rankLabel = result.practice ? '不计' :
                    (result.rank ? '第 ' + result.rank + ' 名' : '待确认');
                var stats = [
                    ['用时', result.elapsed.toFixed(1) + ' 秒'],
                    ['跑道进度', Math.floor(result.progress) + '%'],
                    ['收集得分', U.group(result.score)],
                    ['竞速积分', U.group(result.raceScore)],
                    ['最终名次', rankLabel],
                    ['最高连击', result.comboMax + ' HIT'],
                    ['星星 / 礼物', result.stars + ' / ' + result.gifts],
                    ['刮刮乐', result.cards + ' 张']
                ];
                var html = '';
                for (var i = 0; i < stats.length; i++) {
                    html += '<div class="stat"><span>' + stats[i][0] + '</span><b>' + stats[i][1] + '</b></div>';
                }
                el.resultStats.innerHTML = html;
                renderBoard(result.raceScore);
                renderRecord(record);
            }

            /* -------------------------------------------------------- 摇一摇授权 */
            function enableShakeFlow() {
                PG.Input.enableShake({ onStep: function (side) { game.step(side, 'shake'); } })
                    .then(function (ok) {
                        var label = ok ? '已开启' : '未授权';
                        el.bShake.textContent = label;
                        el.bShakeStart.textContent = ok ? '摇一摇 已开启' : '摇一摇 未授权';
                        toast(ok ? '摇动手机即可加速' : '未能开启摇一摇，连点屏幕同样可以加速');
                    });
            }
            /* 只在「以触控为主」的设备上显示摇一摇：Chromium 桌面同样会暴露 ontouchstart 与
               maxTouchPoints，必须用 hover / pointer 媒体特征判断，触屏笔记本接鼠标时也不显示 */
            var coarse = global.matchMedia ? global.matchMedia('(hover: none) and (pointer: coarse)') : null;
            var touchCapable = coarse ? coarse.matches : !!(global.navigator && global.navigator.maxTouchPoints > 0);
            if (touchCapable && PG.Input.shakeSupported()) {
                show(el.bShake, true);
                show(el.bShakeStart, true);
                el.bShake.addEventListener('click', enableShakeFlow);
                el.bShakeStart.addEventListener('click', enableShakeFlow);
            } else {
                el.bShake.parentNode.classList.add('keys--noshake');
            }

            /* -------------------------------------------------------- 按钮 */
            el.bPrimary.addEventListener('click', begin);
            el.bStartInline.addEventListener('click', begin);
            el.bPause.addEventListener('click', function () { game.pause(); });
            el.bRestart.addEventListener('click', function () { A.init(); game.restart(); });
            el.bResume.addEventListener('click', function () { game.resume(); });
            el.bPauseRestart.addEventListener('click', function () { A.init(); game.restart(); });
            el.bAgain.addEventListener('click', function () { A.init(); game.restart(); });
            el.bSound.addEventListener('click', function () {
                var on = A.setEnabled(!A.isEnabled());
                el.bSound.textContent = on ? '音效 开' : '音效 关';
                el.bSound.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
            /* 手机端在昵称框按 Enter 直接开始 */
            if (el.playerName) {
                el.playerName.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter') { e.preventDefault(); begin(); }
                });
            }

            renderBoard(0);
            renderRecord(ST.load());
            showPhase(PHASE.READY);

            return {
                onFrame: updateHUD,
                onPhase: showPhase,
                onCountdown: setCountdown,
                onToast: toast,
                onShake: shake,
                onFever: function (on) { show(el.fever, on); },
                onResult: showResult,
                onBoard: refreshBoard,
                onMode: function (mode) {
                    var online = mode === 'api';
                    el.modeBadge.textContent = online ? '全场实时' : '本地演示';
                    el.modeBadge.className = 'plate ' + (online ? 'plate--online' : 'plate--quiet');
                    el.boardNote.textContent = online
                        ? '榜单来自晚会服务端，所有手机的成绩实时汇总。'
                        : '当前为单机演示（本地模拟 12 位信息员）。用 server.py 托管后即为全场实时榜单。';
                },
                onScoreSubmitted: function (result, remote) {
                    if (remote && remote.rank) toast('成绩已上传 · 全场第 ' + remote.rank + ' 名');
                }
            };
        }
    };
})(window);
