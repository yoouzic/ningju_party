/* ==========================================================================
   storage.js —— 本机最佳记录（localStorage；file:// 下不可用时静默降级）
   ========================================================================== */
(function (global) {
    'use strict';
    var PG = global.PG = global.PG || {};
    var KEY = 'pixel-rush.best.v1';

    var EMPTY = { plays: 0, bestScore: 0, bestRaceScore: 0, bestRank: 0, bestTime: 0, bestCombo: 0, totalCards: 0, wins: 0 };

    function read() {
        try {
            var raw = global.localStorage && global.localStorage.getItem(KEY);
            if (!raw) return copy(EMPTY);
            var data = JSON.parse(raw);
            var out = copy(EMPTY);
            for (var k in EMPTY) {
                if (Object.prototype.hasOwnProperty.call(data, k) && typeof data[k] === 'number') out[k] = data[k];
            }
            return out;
        } catch (e) {
            return copy(EMPTY);
        }
    }

    function copy(o) {
        var r = {}, k;
        for (k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; }
        return r;
    }

    function write(data) {
        try {
            if (global.localStorage) global.localStorage.setItem(KEY, JSON.stringify(data));
        } catch (e) { /* 隐私模式 / file:// 限制：忽略 */ }
        return data;
    }

    PG.Storage = {
        load: read,

        /* result 来自 rules.computeResult；返回更新后的记录 */
        commit: function (result) {
            var d = read();
            d.plays += 1;
            d.totalCards += result.cards || 0;
            if (result.win) d.wins += 1;
            if (result.score > d.bestScore) d.bestScore = result.score;
            if (result.raceScore > d.bestRaceScore) d.bestRaceScore = result.raceScore;
            if (result.comboMax > d.bestCombo) d.bestCombo = result.comboMax;
            if (result.rank > 0 && (d.bestRank === 0 || result.rank < d.bestRank)) d.bestRank = result.rank;
            if (result.finished && (d.bestTime === 0 || result.elapsed < d.bestTime)) d.bestTime = result.elapsed;
            return write(d);
        },

        reset: function () { return write(copy(EMPTY)); }
    };
})(window);
