/* ==========================================================================
   layout.js —— 竖屏几何抽象层
   把「三条跑道 / 角色位置 / 道具运动方向 / 终点线」集中到一处，
   后续要改横屏、改跑道数、改角色位置，只需替换本文件。
   ========================================================================== */
(function (global) {
    'use strict';
    var PG = global.PG = global.PG || {};
    var C = PG.CONFIG, U = PG.Utils;
    var T = C.TRACK, W = C.VIEW.W, H = C.VIEW.H;

    PG.Layout = {
        W: W, H: H,
        TOP: T.TOP, LEFT: T.LEFT, LANE_W: T.LANE_W, COUNT: T.COUNT,
        PLAYER_Y: C.PLAYER.Y,

        laneCenter: function (i) { return C.laneX(i); },
        laneLeft: function (i) { return T.LEFT + T.LANE_W * i; },
        laneFromX: function (x) {
            return U.clamp(Math.floor((x - T.LEFT) / T.LANE_W), 0, T.COUNT - 1);
        },

        /* 角色固定在画面下方，只做左右换道 */
        playerX: function (lane) { return C.laneX(lane) - C.PLAYER.W / 2; },
        playerY: function () { return C.PLAYER.Y - C.PLAYER.H / 2; },

        /* 碰撞盒比贴图略小，手感更宽容 */
        playerBox: function (p) { return { x: p.x + 6, y: p.y + 6, w: p.w - 12, h: p.h - 8 }; },
        itemBox: function (it) { return { x: it.x + 3, y: it.y + 3, w: it.w - 6, h: it.h - 6 }; },

        spawn: function (type, lane) {
            return {
                type: type, lane: lane,
                x: C.laneX(lane) - C.ITEM_SIZE / 2,
                y: C.ITEM_SPAWN_Y,
                w: C.ITEM_SIZE, h: C.ITEM_SIZE, size: C.ITEM_SIZE,
                spin: 0, alive: true
            };
        },

        /* 道具自上而下迎面而来 */
        advance: function (it, d) { it.y += d; },
        offscreen: function (it) { return it.y > H + 24; },
        nearSpawn: function (it) { return it.y < 40; },

        /* 终点线随进度从远处（上方）向角色逼近 */
        gateY: function (progress) {
            return T.TOP + (U.clamp(progress, 0, 100) / 100) * (C.PLAYER.Y - 20 - T.TOP);
        }
    };
})(window);
