/* ==========================================================================
   main.js —— 启动装配 + 服务端轮次驱动
   正式模式：主持人开赛/结束轮次由服务端 status 轮询驱动，客户端不自行开赛。
   ========================================================================== */
(function (global) {
    'use strict';

    function boot() {
        var PG = global.PG;
        var doc = global.document;
        var canvas = doc.getElementById('game-canvas');
        var screen = doc.getElementById('stage');
        if (!canvas || !canvas.getContext) return;

        /* 画布按设备像素整数倍放大，任何 DPR 下都不会出现半像素 */
        var fitK = 0;
        function fitScreen() {
            var avail = screen.clientWidth;
            /* 画布会把 #stage 的 min-content 撑大，必须用外壳内容宽度兜底，
               否则 390px 手机会算出 2 倍画布并横向溢出 */
            var shell = screen.parentElement;
            if (shell) {
                var cs = global.getComputedStyle(shell);
                var inner = shell.clientWidth
                    - (parseFloat(cs.paddingLeft) || 0)
                    - (parseFloat(cs.paddingRight) || 0) - 8;
                if (inner > 0 && avail > inner) avail = inner;
            }
            if (!avail) return;
            var dpr = global.devicePixelRatio || 1;
            var k = Math.max(1, Math.floor(avail * dpr / PG.Layout.W));
            if (k === fitK && canvas.width) return;
            fitK = k;
            canvas.width = PG.Layout.W * k;
            canvas.height = PG.Layout.H * k;
            canvas.style.width = (PG.Layout.W * k / dpr) + 'px';
            canvas.style.height = (PG.Layout.H * k / dpr) + 'px';
        }
        fitScreen();
        var resizeTimer = 0;
        global.addEventListener('resize', function () {
            global.clearTimeout(resizeTimer);
            resizeTimer = global.setTimeout(fitScreen, 120);
        });

        var game = new PG.Game(canvas);
        game.hooks = PG.UI.init(game);

        PG.Input.init({
            canvas: canvas,
            onStep: function (side, source) { game.step(side, source); },
            onLaneDelta: function (d) { game.laneDelta(d); },
            onLaneAt: function (lane) { game.setLane(lane); },
            onPause: function () { game.pause(); },
            onConfirm: function () { PG.Audio.init(); game.confirm(); },
            onFirstGesture: function () { PG.Audio.init(); }
        });

        doc.addEventListener('visibilitychange', function () {
            if (doc.hidden && game.s.phase === PG.PHASE.PLAYING) game.pause();
        });

        game.start();
        global.PixelRush = game;

        /* ---- 连接服务端并驱动轮次 ---- */
        PG.Net.detect().then(function (mode) {
            game.emit('onMode', mode);
            if (mode === 'practice') {
                game.s.practice = true;
                game.s.online = false;
                game.emit('onPartyState', { text: '练习模式 · 成绩不计入榜单', kind: 'practice',
                                            me: null, stats: null });
                return;
            }
            game.s.online = true;
            game.s.practice = false;

            var lastRoundId = 0;
            var lastStatus = '';
            function poll() {
                PG.Net.status().then(function (st) {
                    if (!st) return;
                    var r = st.round;
                    var s = game.s;
                    s.serverTimeLeft = r && r.status === 'running' ? r.seconds_left : 0;

                    game.emit('onBoard', (st.board && st.board.entries) || []);

                    /* 名次：优先采用服务端本轮结算结果 st.me.result.rank，否则扫榜单 */
                    if (st.me) {
                        var myRank = st.me.result && st.me.result.rank;
                        if (myRank) {
                            s.rank = myRank;
                        } else if (st.board && st.board.entries) {
                            for (var i = 0; i < st.board.entries.length; i++) {
                                if (st.board.entries[i].player_id === st.me.id) {
                                    s.rank = st.board.entries[i].rank;
                                    break;
                                }
                            }
                        }
                    }

                    if (!r || r.kind !== 'shake') {
                        var txt = !r ? '等待主持人开赛' :
                            (r.kind === 'quiz' ? '当前是答题环节 · 请扫大屏二维码' : '本环节已结束');
                        game.emit('onPartyState', { text: txt, kind: r ? r.kind : 'idle',
                                                    round: r, me: st.me, stats: st.stats });
                        if (s.phase === PG.PHASE.PLAYING || s.phase === PG.PHASE.COUNTDOWN) {
                            game.finishByRound(s.rank);
                        }
                        lastStatus = '';
                        return;
                    }

                    if (r.status === 'running' && r.id !== lastRoundId) {
                        if (!PG.Net.getPlayer()) {
                            game.emit('onPartyState', { text: '请先登录，再等待主持人开赛', kind: 'need-login',
                                                        round: r, me: st.me, stats: st.stats });
                        } else {
                            lastRoundId = r.id;
                            game.beginRound(r);
                            game.emit('onPartyState', { text: '第①环节进行中', kind: 'running',
                                                        round: r, me: st.me, stats: st.stats });
                        }
                    } else if (r.status === 'running') {
                        game.emit('onPartyState', { text: '第①环节进行中', kind: 'running',
                                                    round: r, me: st.me, stats: st.stats });
                    } else if (r.status === 'closed' && lastStatus !== 'closed') {
                        lastStatus = 'closed';
                        game.emit('onPartyState', { text: '本环节已结束 · 请查看大屏榜单', kind: 'closed',
                                                    round: r, me: st.me, stats: st.stats });
                        if (s.phase === PG.PHASE.PLAYING || s.phase === PG.PHASE.COUNTDOWN) {
                            game.finishByRound(s.rank);
                        }
                    }
                });
            }
            poll();
            game.pollTimer = global.setInterval(poll, 1500);
            /* 玩家登录后立即重新驱动一次轮次，避免错过正在进行的比赛 */
            doc.addEventListener('ningju:joined', function () {
                lastRoundId = 0;
                lastStatus = '';
                poll();
            });
        });
    }

    if (global.document.readyState === 'loading') {
        global.document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})(window);
