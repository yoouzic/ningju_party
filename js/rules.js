/* ==========================================================================
   rules.js —— 全部玩法判定：掉落表 / 难度曲线 / 计分 / 名次 / 结算
   与渲染、输入完全解耦，后续换成服务端成绩只需替换 BOT_SCORES 来源
   ========================================================================== */
(function (global) {
    'use strict';
    var PG = global.PG = global.PG || {};
    var C = PG.CONFIG;
    var U = PG.Utils;

    /* 榜单基准：默认本地模拟 12 位信息员；接入晚会服务端后由 PG.Net 覆盖 */
    var BOTS = C.BOT_SCORES.map(function (b) { return { name: b.name, score: b.score }; });

    function itemWeights(progress) {
        var w = {};
        for (var k in C.BASE_WEIGHTS) { if (Object.prototype.hasOwnProperty.call(C.BASE_WEIGHTS, k)) w[k] = C.BASE_WEIGHTS[k]; }
        /* 越接近终点，乌云越多、爱心越少 */
        w.cloud = Math.round(w.cloud + progress * 0.20);
        w.heart = Math.max(3, Math.round(w.heart - progress * 0.025));
        return w;
    }

    function spawnInterval(progress) {
        return U.lerp(C.SPAWN_BASE, C.SPAWN_MIN, U.clamp(progress / 100, 0, 1));
    }

    function scrollSpeed(speed) {
        return C.SCROLL_BASE + speed * C.SCROLL_SPEED_FACTOR;
    }

    function stepGain(isAlternate) {
        return C.STEP_GAIN * (isAlternate ? C.ALTERNATE_BONUS : 1);
    }

    function comboMultiplier(combo) {
        return Math.min(C.COMBO_MULT_MAX, 1 + Math.floor(combo / C.COMBO_STEP) * C.COMBO_MULT_STEP);
    }

    function collectScore(type, combo, fever) {
        var base = C.SCORE[type] || 0;
        return Math.round(base * comboMultiplier(combo) * (fever ? C.FEVER_SCORE_MULT : 1));
    }

    function raceScoreOf(s) {
        var bonus = s.finished
            ? C.FINISH_BONUS + Math.max(0, s.timeLeft) * C.TIME_BONUS_PER_SEC
            : s.progress * C.PROGRESS_SCORE;
        return Math.round(s.score + bonus + (s.comboMax || 0) * C.COMBO_SCORE);
    }

    /* 把 12 位模拟信息员与玩家一起排序，返回 [{name,score,isPlayer,rank,cut}] */
    function ranking(playerScore) {
        var entries = BOTS.map(function (b) {
            return { name: b.name, score: b.score, isPlayer: false };
        });
        entries.push({ name: '你 · 小凝', score: Math.round(playerScore), isPlayer: true });
        entries.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            if (a.isPlayer) return -1;
            if (b.isPlayer) return 1;
            return 0;
        });
        for (var i = 0; i < entries.length; i++) {
            entries[i].rank = i + 1;
            entries[i].cut = entries[i].rank > C.TOP_N;
        }
        return entries;
    }

    function rankOf(playerScore) {
        var list = ranking(playerScore);
        for (var i = 0; i < list.length; i++) if (list[i].isPlayer) return list[i].rank;
        return list.length;
    }

    function computeResult(s) {
        var rs = raceScoreOf(s);
        var rank = rankOf(rs);
        var win = !!s.finished && rank <= C.TOP_N;
        var cards = Math.floor((s.gifts || 0) / C.GIFTS_PER_CARD);
        return {
            finished: !!s.finished,
            win: win,
            rank: rank,
            raceScore: rs,
            score: s.score,
            progress: Math.min(100, s.progress),
            elapsed: s.elapsed,
            timeLeft: Math.max(0, s.timeLeft),
            comboMax: s.comboMax || 0,
            stars: s.stars || 0,
            gifts: s.gifts || 0,
            hits: s.hits || 0,
            cards: cards,
            lives: s.lives,
            cause: s.cause || 'time'
        };
    }

    function verdict(r) {
        if (r.win) return {
            ribbon: 'CLEAR!', cls: 'tab--win', title: '晋级成功！',
            desc: '步数进入晚会摇动榜前 10 名，可到舞台左侧领取刮刮乐 ×1 + 小礼物。'
        };
        if (r.finished) return {
            ribbon: 'FINISH', cls: '', title: '达到目标，但差一点',
            desc: '已经达到进度参考步数，但步数没进前 10。继续摇得更快就能晋级。'
        };
        if (r.cause === 'lives') return {
            ribbon: 'GAME OVER', cls: 'tab--lose', title: '被乌云拦下',
            desc: '3 颗爱心用完了。点左中右提前换道，躲开自上而下的乌云。'
        };
        return {
            ribbon: 'TIME UP', cls: 'tab--lose', title: '时间到 · 未进前 10',
            desc: '45 秒内步数没有进入前 10 名。摇得越快越稳，下一轮再试。'
        };
    }

    /* 榜单展示：前 10 + 若玩家在前 10 之外则额外附一行 */
    function boardRows(playerScore) {
        var list = ranking(playerScore);
        var rows = list.slice(0, C.TOP_N);
        var player = null;
        for (var i = 0; i < list.length; i++) if (list[i].isPlayer) player = list[i];
        if (player && player.rank > C.TOP_N) rows.push(player);
        return rows;
    }

    /* 服务端下发真实榜单后覆盖基准成绩（同时用于 HUD 的实时名次预估） */
    function setBots(list) {
        if (!list || !list.length) return;
        BOTS = list.map(function (b) {
            return { name: String(b.name || '信息员'), score: Number(b.score) || 0 };
        });
    }

    /* 大屏 / 侧栏展示服务端真实榜单：前 10 名 + 高亮当前玩家 */
    function serverRows(entries, playerName) {
        var list = (entries || []).map(function (e, i) {
            return {
                name: String(e.name || '信息员'), score: Number(e.score) || 0,
                isPlayer: !!playerName && e.name === playerName,
                rank: i + 1, cut: i >= C.TOP_N
            };
        });
        var rows = list.slice(0, C.TOP_N);
        if (playerName) {
            var mine = null;
            for (var i = 0; i < list.length; i++) if (list[i].isPlayer) mine = list[i];
            if (mine && mine.rank > C.TOP_N) rows.push(mine);
        }
        return rows;
    }

    PG.Rules = {
        setBots: setBots,
        serverRows: serverRows,
        itemWeights: itemWeights,
        spawnInterval: spawnInterval,
        scrollSpeed: scrollSpeed,
        stepGain: stepGain,
        comboMultiplier: comboMultiplier,
        collectScore: collectScore,
        raceScoreOf: raceScoreOf,
        ranking: ranking,
        rankOf: rankOf,
        computeResult: computeResult,
        verdict: verdict,
        boardRows: boardRows
    };
})(window);
