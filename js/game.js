/* ==========================================================================
   game.js —— 主控：状态机 + 固定步长循环 + 玩法装配
   状态：ready → countdown → playing ⇄ paused → over → (restart) ready
   只通过 hooks 通知 UI，不直接操作 DOM；多人上报也只通过 PG.Net 适配层
   ========================================================================== */
(function (global) {
    'use strict';
    var PG = global.PG = global.PG || {};
    var C = PG.CONFIG, U = PG.Utils, E = PG.Entities, L = PG.Layout;
    var R = PG.Rules, A = PG.Audio, ST = PG.Storage;
    var P = PG.Sprites.PALETTE;

    var PHASE = { READY: 'ready', COUNTDOWN: 'countdown', PLAYING: 'playing', PAUSED: 'paused', OVER: 'over' };
    var STEP = 1 / 60;

    function Game(canvas, hooks) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.hooks = hooks || {};
        this.raf = 0;
        this.last = 0;
        this.acc = 0;
        this.running = false;
        this.reset();
    }

    Game.prototype.reset = function () {
        this.s = {
            phase: PHASE.READY,
            time: 0,
            elapsed: 0,
            timeLeft: C.TIME_LIMIT,
            score: 0,
            combo: 0,
            comboMax: 0,
            comboTimer: 0,
            energy: 0,
            fever: 0,
            speed: 0,
            progress: 0,
            scroll: R.scrollSpeed(0),
            lives: C.LIVES,
            stars: 0,
            gifts: 0,
            hits: 0,
            rank: 0,
            finished: false,
            cause: 'time',
            countdown: C.COUNTDOWN,
            spawnTimer: 0.7,
            stepCooldown: 0,
            lastSide: null,
            /* 正式模式：进度/时间/名次由服务端权威下发 */
            pendingSteps: 0,
            syncTimer: 0,
            serverTimeLeft: C.TIME_LIMIT,
            online: false,
            practice: false,
            player: E.createPlayer(),
            items: [],
            particles: [],
            floatTexts: [],
            rivals: E.createRivals()
        };
        return this.s;
    };

    Game.prototype.emit = function (name, a, b) {
        var fn = this.hooks[name];
        if (fn) fn(a, b);
    };
    Game.prototype.setPhase = function (p) {
        this.s.phase = p;
        this.emit('onPhase', p, this.s);
    };
    Game.prototype.toast = function (text) { this.emit('onToast', text); };

    /* ------------------------------------------------------------ 流程控制 */
    Game.prototype.startGame = function () {
        var ph = this.s.phase;
        if (ph !== PHASE.READY && ph !== PHASE.OVER) return;
        if (ph === PHASE.OVER) this.reset();
        A.init();
        A.play('start');
        this.s.countdown = C.COUNTDOWN;
        this.setPhase(PHASE.COUNTDOWN);
        this.emit('onCountdown', String(C.COUNTDOWN));
    };

    /* 主持人开赛：服务端计时已经开始，客户端不再本地倒计时，直接进入游戏 */
    Game.prototype.beginRound = function (round) {
        var ph = this.s.phase;
        if (ph === PHASE.PLAYING) return;              /* 同一轮次的重复轮询不重启 */
        /* 上一轮已结算 / 暂停 / 本地倒计时残留，都要先清干净再进入新轮次 */
        if (ph !== PHASE.READY) this.reset();
        this.s.online = true;
        this.s.practice = false;
        this.s.serverTimeLeft = (round && round.seconds_left) || C.TIME_LIMIT;
        this.s.timeLeft = this.s.serverTimeLeft;
        A.init();
        A.play('go');
        this.setPhase(PHASE.PLAYING);
        this.toast('开赛！摇动手机冲向终点');
    };

    /* 正式模式「返回等待」：只清本地表现，不开本地倒计时，等主持人下一次开赛 */
    Game.prototype.waitReset = function () {
        this.reset();
        this.s.online = true;
        this.s.practice = false;
        this.setPhase(PHASE.READY);
    };

    /* 主持人结束轮次或时间到：以服务端名次结算 */
    Game.prototype.finishByRound = function (rank) {
        if (this.s.phase === PHASE.OVER) return;
        this.s.cause = 'time';
        this.finish({ rank: rank || 0 });
    };

    /* 把本地有效步数批量上报，服务端按时间差限速并回传权威进度 */
    Game.prototype.syncSteps = function () {
        var s = this.s;
        if (!s.online || s.phase !== PHASE.PLAYING || !PG.Net || !PG.Net.isOnline()) return;
        var n = Math.min(12, s.pendingSteps);
        s.pendingSteps = 0;
        if (n <= 0) return;
        var self = this;
        PG.Net.step(n).then(function (r) {
            if (!r || self.s !== s || s.phase === PHASE.OVER) return;
            s.progress = Math.max(s.progress, r.progress);
            if (r.finished) {
                s.progress = 100;
                s.finished = true;
                s.cause = 'finish';
                s.rank = r.rank || 0;
                self.finish({ rank: r.rank });
            }
        });
    };

    Game.prototype.confirm = function () {
        var ph = this.s.phase;
        if (ph === PHASE.READY || ph === PHASE.OVER) {
            if (this.s.online) this.toast('请等待主持人开赛');
            else this.startGame();
        } else if (ph === PHASE.PAUSED) this.resume();
    };

    Game.prototype.pause = function () {
        if (this.s.phase === PHASE.PLAYING) this.setPhase(PHASE.PAUSED);
        else if (this.s.phase === PHASE.PAUSED) this.resume();
    };
    Game.prototype.resume = function () {
        if (this.s.phase === PHASE.PAUSED) this.setPhase(PHASE.PLAYING);
    };
    Game.prototype.restart = function () {
        this.reset();
        this.setPhase(PHASE.READY);
        this.startGame();
    };

    /* ------------------------------------------------------------ 输入语义 */
    Game.prototype.setLane = function (lane) {
        var ph = this.s.phase;
        if (ph !== PHASE.PLAYING && ph !== PHASE.COUNTDOWN) return;
        this.s.player.targetLane = U.clamp(lane, 0, L.COUNT - 1);
    };
    Game.prototype.laneDelta = function (d) { this.setLane(this.s.player.targetLane + d); };

    Game.prototype.gainEnergy = function (amount) {
        var s = this.s;
        s.energy = Math.min(C.ENERGY_MAX, s.energy + amount);
        if (s.energy >= C.ENERGY_MAX && s.fever <= 0) {
            s.energy = 0;
            s.fever = C.FEVER_DURATION;
            A.play('fever');
            this.toast('★ FEVER！速度 ×1.7 得分 ×2');
            E.burst(s.particles, s.player.x + 16, s.player.y + 16, [P.y, P.w, P.p], 18);
            this.emit('onFever', true);
        }
    };

    Game.prototype.step = function (side, source) {
        var s = this.s;
        if (s.phase !== PHASE.PLAYING || s.stepCooldown > 0) return;
        s.stepCooldown = C.STEP_COOLDOWN;
        var alternate = !!(s.lastSide && side !== 'neutral' && s.lastSide !== side);
        s.lastSide = (side === 'neutral') ? null : side;
        s.speed = Math.min(C.MAX_SPEED, s.speed + R.stepGain(alternate));
        s.combo += 1;
        s.comboMax = Math.max(s.comboMax, s.combo);
        s.comboTimer = C.COMBO_WINDOW;
        this.gainEnergy(C.ENERGY_PER_STEP);
        /* 正式模式：每次有效摇动累计为服务端步数，FEVER 期间额外加成 */
        if (s.online) s.pendingSteps += (s.fever > 0 ? 2 : 1);
        if (s.combo % 3 === 1) A.play('step');
        if (s.combo % 2 === 1) E.burst(s.particles, s.player.x + 16, s.player.y + 30, [P.w, P.s], 2);
    };

    /* ------------------------------------------------------------ 收集 / 受击 */
    Game.prototype.collect = function (it) {
        var s = this.s;
        var fx = it.x, fy = it.y;
        if (it.type === 'cloud') { this.hit(it); return; }

        var pts = R.collectScore(it.type, s.combo, s.fever > 0);
        s.score += pts;
        s.combo += 1;
        s.comboMax = Math.max(s.comboMax, s.combo);
        s.comboTimer = C.COMBO_WINDOW;
        s.floatTexts.push(E.createFloatText(fx - 4, fy - 8, '+' + pts, it.type === 'gift' ? P.y : P.w));

        if (it.type === 'star') {
            s.stars += 1;
            E.burst(s.particles, fx + 8, fy + 8, [P.y, P.w, P.Y], 10);
            A.play('star');
        } else if (it.type === 'gift') {
            s.gifts += 1;
            E.burst(s.particles, fx + 8, fy + 8, [P.p, P.y, P.b, P.w], 14);
            A.play('gift');
            if (s.gifts % C.GIFTS_PER_CARD === 0) this.toast('★ 集齐 3 个礼物：刮刮乐 ×1');
        } else if (it.type === 'heart') {
            s.lives = Math.min(C.LIVES, s.lives + 1);
            E.burst(s.particles, fx + 8, fy + 8, [P.r, P.p, P.w], 10);
            A.play('heart');
            this.toast('♥ 回复 1 颗爱心');
        }
        this.gainEnergy(4);
    };

    Game.prototype.hit = function (it) {
        var s = this.s;
        if (s.player.invuln > 0) return;
        s.hits += 1;
        s.lives -= 1;
        s.combo = 0;
        s.comboTimer = 0;
        s.speed *= C.HIT_SPEED_MULT;
        s.player.invuln = C.HIT_INVULN;
        s.floatTexts.push(E.createFloatText(it.x, it.y - 8, '-1 ♥', P.r));
        E.burst(s.particles, it.x + 8, it.y + 8, [P.s, P.O, P.r], 12);
        A.play('hit');
        this.toast('乌云！速度减半、掉 1 颗心');
        this.emit('onShake');
        if (s.lives <= 0) { s.cause = 'lives'; this.finish(); }
    };

    /* ------------------------------------------------------------ 结算 + 成绩上报 */
    Game.prototype.celebrate = function () {
        var s = this.s;
        var colors = [P.p, P.b, P.y, P.w, P.g, P.v];
        for (var i = 0; i < 70; i++) {
            s.particles.push(E.createParticle(U.rand(0, L.W), U.rand(-20, 40), colors[i % colors.length], {
                vx: U.rand(-40, 40), vy: U.rand(20, 70), gravity: 28,
                life: U.rand(1.0, 2.2), size: U.randInt(2, 4)
            }));
        }
    };

    Game.prototype.finish = function (serverInfo) {
        if (this.s.phase === PHASE.OVER) return;
        var s = this.s;
        var result = R.computeResult(s);
        if (serverInfo && serverInfo.rank) {
            /* 服务端名次是唯一依据：不再要求本地 finished 也为真 */
            result.rank = serverInfo.rank;
            result.win = result.rank <= C.TOP_N;
            result.pending = false;
            s.finished = true;
            s.cause = 'finish';
        } else if (s.online) {
            /* 轮次被主持人结束时，名次以服务端榜单为准；未上榜显示待确认 */
            result.rank = 0;
            result.win = false;
            result.pending = true;
        }
        result.practice = !!s.practice;
        s.rank = result.rank;
        var record = ST.commit(result);
        A.play(result.win ? 'finish' : 'fail');
        if (result.win) this.celebrate();
        this.setPhase(PHASE.OVER);
        this.emit('onResult', result, record);
    };

    /* ------------------------------------------------------------ 每步更新 */
    Game.prototype.update = function (dt) {
        var s = this.s;
        if (s.phase === PHASE.PAUSED) return;
        s.time += dt;

        if (s.phase === PHASE.COUNTDOWN) {
            var prev = Math.ceil(s.countdown);
            s.countdown -= dt;
            var cur = Math.ceil(s.countdown);
            if (cur !== prev && cur > 0) A.play('count');
            if (s.countdown <= 0) {
                this.setPhase(PHASE.PLAYING);
                A.play('go');
                this.emit('onCountdown', 'GO!');
                this.toast('GO! 摇动手机 / 连点屏幕冲刺');
            } else {
                this.emit('onCountdown', String(cur));
            }
        }

        if (s.phase !== PHASE.PLAYING) {
            E.updateParticles(s.particles, dt);
            E.updateFloatTexts(s.floatTexts, dt);
            return;
        }

        s.elapsed += dt;
        if (s.online) {
            s.serverTimeLeft = Math.max(0, s.serverTimeLeft - dt);
            s.timeLeft = s.serverTimeLeft;
        } else {
            s.timeLeft = Math.max(0, C.TIME_LIMIT - s.elapsed);
        }
        s.stepCooldown = Math.max(0, s.stepCooldown - dt);
        s.speed = Math.max(0, s.speed - (C.SPEED_DECAY + s.speed * C.SPEED_DRAG) * dt);
        s.energy = Math.max(0, s.energy - C.ENERGY_DECAY * dt);
        s.comboTimer -= dt;
        if (s.comboTimer <= 0) s.combo = 0;
        if (s.fever > 0) {
            s.fever -= dt;
            if (s.fever <= 0) { s.fever = 0; this.emit('onFever', false); }
        }
        s.player.invuln = Math.max(0, s.player.invuln - dt);

        /* 换道：竖版只平滑 x */
        var targetX = L.playerX(s.player.targetLane);
        s.player.x = U.lerp(s.player.x, targetX, Math.min(1, dt / C.PLAYER.MOVE_TIME));
        s.player.lane = s.player.targetLane;
        s.player.frameTimer += dt * (4 + s.speed / 24);
        while (s.player.frameTimer >= 1) {
            s.player.frameTimer -= 1;
            s.player.frame = 1 - s.player.frame;
        }

        var mult = s.fever > 0 ? C.FEVER_PROGRESS_MULT : 1;
        if (s.online) {
            /* 正式模式：权威进度来自服务端累计步数，本地只做表现 */
            s.syncTimer -= dt;
            if (s.syncTimer <= 0) { s.syncTimer = 0.18; this.syncSteps(); }
        } else {
            s.progress += s.speed * C.PROGRESS_PER_SPEED * mult * dt;
            s.rank = R.rankOf(R.raceScoreOf(s));
        }
        s.scroll = R.scrollSpeed(s.speed);

        for (var r = 0; r < s.rivals.length; r++) {
            var rv = s.rivals[r];
            rv.progress = Math.min(100, rv.progress + rv.rate * dt * (0.92 + 0.16 * Math.sin(s.time * 0.8 + rv.bob)));
        }

        /* 生成掉落物 */
        s.spawnTimer -= dt;
        if (s.spawnTimer <= 0) {
            var lane = U.randInt(0, L.COUNT - 1);
            var crowded = false;
            for (var q = 0; q < s.items.length; q++) {
                if (s.items[q].lane === lane && L.nearSpawn(s.items[q])) { crowded = true; break; }
            }
            if (!crowded) {
                var type = U.weightedPick(R.itemWeights(s.progress));
                s.items.push(E.createItem(type, lane));
                s.spawnTimer = R.spawnInterval(s.progress) * U.rand(0.85, 1.2);
            } else {
                s.spawnTimer = 0.14;
            }
        }

        /* 道具自上而下移动 + 碰撞 */
        var pb = E.playerBox(s.player);
        for (var i = s.items.length - 1; i >= 0; i--) {
            var it = s.items[i];
            L.advance(it, s.scroll * dt);
            it.spin += dt;
            if (L.offscreen(it)) { s.items.splice(i, 1); continue; }
            if (it.alive && U.hits(pb, E.itemBox(it))) {
                it.alive = false;
                s.items.splice(i, 1);
                this.collect(it);
                if (s.phase === PHASE.OVER) return;
            }
        }

        E.updateParticles(s.particles, dt);
        E.updateFloatTexts(s.floatTexts, dt);

        if (s.progress >= 100) {
            s.progress = 100;
            s.finished = true;
            s.cause = 'finish';
            this.finish();
            return;
        }
        if (s.timeLeft <= 0) { s.cause = 'time'; this.finish(); return; }
        if (s.lives <= 0) { s.cause = 'lives'; this.finish(); }
    };

    /* ------------------------------------------------------------ 主循环 */
    Game.prototype.frame = function (ts) {
        if (!this.running) return;
        var dt = this.last ? (ts - this.last) / 1000 : 0;
        this.last = ts;
        if (dt > 0.1) dt = 0.1;
        this.acc += dt;
        var guard = 0;
        while (this.acc >= STEP && guard < 8) {
            this.update(STEP);
            this.acc -= STEP;
            guard++;
        }
        if (guard >= 8) this.acc = 0;
        if (this.ctx) PG.Renderer.draw(this.ctx, this.s);
        this.emit('onFrame', this.s);
        this.raf = global.requestAnimationFrame(this.frame.bind(this));
    };

    Game.prototype.start = function () {
        if (this.running) return;
        this.running = true;
        this.last = 0;
        this.raf = global.requestAnimationFrame(this.frame.bind(this));
    };
    Game.prototype.stop = function () {
        this.running = false;
        if (this.raf) global.cancelAnimationFrame(this.raf);
        this.raf = 0;
    };

    PG.Game = Game;
    PG.PHASE = PHASE;
})(window);
