/* ==========================================================================
   entities.js —— 游戏对象工厂与轻量更新器（纯数据，渲染交给 renderer.js）
   几何全部委托 PG.Layout，避免竖版/横版切换时散落修改
   ========================================================================== */
(function (global) {
    'use strict';
    var PG = global.PG = global.PG || {};
    var C = PG.CONFIG, U = PG.Utils, L = PG.Layout;

    function createPlayer() {
        return {
            x: L.playerX(C.PLAYER.START_LANE),
            y: L.playerY(),                 // 竖版固定；换道时平滑过渡的是 x
            lane: C.PLAYER.START_LANE,
            targetLane: C.PLAYER.START_LANE,
            w: C.PLAYER.W,
            h: C.PLAYER.H,
            frame: 0,
            frameTimer: 0,
            invuln: 0,
            bob: 0
        };
    }

    function playerBox(p) { return L.playerBox(p); }
    function createItem(type, lane) { return L.spawn(type, lane); }
    function itemBox(it) { return L.itemBox(it); }

    function createParticle(x, y, color, opts) {
        opts = opts || {};
        return {
            x: x, y: y,
            vx: opts.vx !== undefined ? opts.vx : U.rand(-60, 60),
            vy: opts.vy !== undefined ? opts.vy : U.rand(-90, -20),
            gravity: opts.gravity !== undefined ? opts.gravity : 150,
            life: opts.life || 0.55,
            maxLife: opts.life || 0.55,
            color: color,
            size: opts.size || 2
        };
    }

    function createFloatText(x, y, text, color) {
        return { x: x, y: y, text: text, color: color || '#ffffff', life: 0.9, maxLife: 0.9 };
    }

    function createRivals() {
        return C.RIVALS.map(function (r, i) {
            return { name: r.name, tint: r.tint, rate: r.rate, progress: 0, bob: i * 1.3 };
        });
    }

    function updateParticles(list, dt) {
        for (var i = list.length - 1; i >= 0; i--) {
            var p = list[i];
            p.life -= dt;
            if (p.life <= 0) { list.splice(i, 1); continue; }
            p.vy += p.gravity * dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
        }
    }

    function updateFloatTexts(list, dt) {
        for (var i = list.length - 1; i >= 0; i--) {
            var f = list[i];
            f.life -= dt;
            f.y -= 26 * dt;
            if (f.life <= 0) list.splice(i, 1);
        }
    }

    function burst(list, x, y, colors, count) {
        for (var i = 0; i < count; i++) {
            list.push(createParticle(x, y, colors[i % colors.length], {
                vx: U.rand(-95, 95), vy: U.rand(-120, -10),
                life: U.rand(0.35, 0.8), size: U.randInt(2, 4)
            }));
        }
    }

    PG.Entities = {
        createPlayer: createPlayer,
        playerBox: playerBox,
        createItem: createItem,
        itemBox: itemBox,
        createParticle: createParticle,
        createFloatText: createFloatText,
        createRivals: createRivals,
        updateParticles: updateParticles,
        updateFloatTexts: updateFloatTexts,
        burst: burst
    };
})(window);
