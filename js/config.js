/* ==========================================================================
   config.js —— 全部可调参数集中在此，扩展玩法 / 调难度只改这一个文件
   ========================================================================== */
(function (global) {
    'use strict';
    var PG = global.PG = global.PG || {};

    /* 手机竖屏优先：9:16 竖向跑道。
       逻辑分辨率刻意压到 180×320，让「美术像素」足够大（角色 32×32），
       再由 main.js 按设备像素做整数倍放大，任何屏幕上都不会出现宽窄不一的像素。 */
    var VIEW = { W: 180, H: 320 };
    var TRACK = { TOP: 46, LEFT: 0, LANE_W: 60, COUNT: 3 };

    var C = {
        VIEW: VIEW,
        TRACK: TRACK,

        /* 角色 */
        PLAYER: { Y: 282, W: 32, H: 32, SPRITE: 16, START_LANE: 1, MOVE_TIME: 0.11 },

        /* 流程 */
        TIME_LIMIT: 45,
        COUNTDOWN: 3,

        /* 手速 → 速度
           平衡速度 ≈ (每秒有效连打数 × STEP_GAIN − SPEED_DECAY) / SPEED_DRAG，
           因此点得越快稳定速度越高，真正拉开手速差距。 */
        MAX_SPEED: 240,
        SPEED_DECAY: 18,
        SPEED_DRAG: 0.55,
        STEP_GAIN: 19,
        ALTERNATE_BONUS: 1.30,
        STEP_COOLDOWN: 0.075,
        COMBO_WINDOW: 1.10,

        /* 速度 → 进度（% / 秒 = speed × 该系数） */
        PROGRESS_PER_SPEED: 0.021,

        /* FEVER 爆发 */
        ENERGY_PER_STEP: 9,
        ENERGY_DECAY: 14,
        ENERGY_MAX: 100,
        FEVER_DURATION: 5,
        FEVER_PROGRESS_MULT: 1.7,
        FEVER_SCORE_MULT: 2,

        /* 受击 */
        LIVES: 3,
        HIT_INVULN: 1.2,
        HIT_SPEED_MULT: 0.5,

        /* 掉落物 */
        SPAWN_BASE: 0.85,
        SPAWN_MIN: 0.48,
        SCROLL_BASE: 110,
        SCROLL_SPEED_FACTOR: 0.55,
        ITEM_SIZE: 20,
        ITEM_SPAWN_Y: -28,

        /* 计分 */
        SCORE: { star: 60, gift: 150, heart: 80, cloud: 0 },
        COMBO_STEP: 10,
        COMBO_MULT_STEP: 0.25,
        COMBO_MULT_MAX: 3,
        GIFTS_PER_CARD: 3,
        FINISH_BONUS: 600,
        TIME_BONUS_PER_SEC: 20,
        PROGRESS_SCORE: 3,
        COMBO_SCORE: 2,

        /* 结算与榜单（文档：每轮前 10 名领刮刮乐 + 小礼物） */
        TOP_N: 10,
        BOT_SCORES: [
            { name: '信息员·噜噜', score: 1480 },
            { name: '信息员·阿蓝', score: 1320 },
            { name: '信息员·小星', score: 1210 },
            { name: '信息员·咕咕', score: 1100 },
            { name: '信息员·糖糖', score: 1010 },
            { name: '信息员·阿澄', score: 930 },
            { name: '信息员·小满', score: 860 },
            { name: '信息员·布丁', score: 790 },
            { name: '信息员·朵朵', score: 720 },
            { name: '信息员·小野', score: 650 },
            { name: '信息员·阿橘', score: 580 },
            { name: '信息员·团子', score: 500 }
        ],

        /* 掉落物基础权重（rules.js 会随进度提升乌云比例） */
        BASE_WEIGHTS: { star: 52, gift: 20, heart: 6, cloud: 22 },

        /* 三条可见对手（赛道实时进度条用），仅作视觉竞速参照 */
        RIVALS: [
            { name: '小咕', rate: 2.05, tint: 'blue' },
            { name: '阿桃', rate: 2.30, tint: 'pink' },
            { name: '星仔', rate: 1.85, tint: 'yellow' }
        ]
    };

    /* 第 i 条纵向跑道的中心 X（0 = 左，1 = 中，2 = 右） */
    C.laneX = function (i) {
        return TRACK.LEFT + TRACK.LANE_W * i + TRACK.LANE_W / 2;
    };

    PG.CONFIG = C;
})(window);
