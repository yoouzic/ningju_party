/* ==========================================================================
   input.js —— 统一输入层（手机优先）
   主控：摇一摇（DeviceMotion）/ 连点屏幕；键盘仅作为桌面兼容
   game.js 只接收语义化事件（step / lane / pause / confirm），不碰 DOM 事件
   ========================================================================== */
(function (global) {
    'use strict';
    var PG = global.PG = global.PG || {};
    var L = PG.Layout;

    var listeners = [];
    var shaking = false;
    var lastShake = 0;
    var lastAcc = null;

    function bind(target, type, fn) {
        target.addEventListener(type, fn, false);
        listeners.push([target, type, fn]);
    }

    function init(opts) {
        var canvas = opts.canvas;
        var doc = global.document;

        bind(doc, 'keydown', function (e) {
            var k = String(e.code || e.key).toLowerCase();

            if (k === 'enter' || k === 'numpadenter') { opts.onConfirm && opts.onConfirm(); return; }
            if (k === 'keyp' || k === 'escape' || k === 'esc') {
                e.preventDefault(); opts.onPause && opts.onPause(); return;
            }
            /* 桌面兼容：左右键既加速又换道；空格/J/K/上下键纯加速 */
            if (k === 'arrowleft' || k === 'keya') {
                e.preventDefault();
                if (!e.repeat) {
                    opts.onFirstGesture && opts.onFirstGesture();
                    opts.onLaneDelta && opts.onLaneDelta(-1);
                    opts.onStep && opts.onStep('left', 'key');
                }
                return;
            }
            if (k === 'arrowright' || k === 'keyd') {
                e.preventDefault();
                if (!e.repeat) {
                    opts.onFirstGesture && opts.onFirstGesture();
                    opts.onLaneDelta && opts.onLaneDelta(1);
                    opts.onStep && opts.onStep('right', 'key');
                }
                return;
            }
            if (k === 'space' || k === ' ' || k === 'spacebar' || k === 'keyj' || k === 'keyk' ||
                k === 'arrowup' || k === 'keyw' || k === 'arrowdown' || k === 'keys') {
                e.preventDefault();
                if (!e.repeat) {
                    opts.onFirstGesture && opts.onFirstGesture();
                    opts.onStep && opts.onStep('neutral', 'key');
                }
            }
        });

        /* 点屏幕 = 加速一步；点左 / 中 / 右 = 直接换到该跑道 */
        var pressed = false;
        function laneFromEvent(e) {
            var rect = canvas.getBoundingClientRect();
            if (!rect.width) return 1;
            var x = (e.clientX - rect.left) / rect.width * L.W;
            return L.laneFromX(x);
        }
        bind(canvas, 'pointerdown', function (e) {
            pressed = true;
            e.preventDefault();
            opts.onFirstGesture && opts.onFirstGesture();
            opts.onLaneAt && opts.onLaneAt(laneFromEvent(e));
            opts.onStep && opts.onStep('neutral', 'pointer');
        });
        bind(canvas, 'pointermove', function (e) {
            if (!pressed) return;
            opts.onLaneAt && opts.onLaneAt(laneFromEvent(e));
        });
        bind(global, 'pointerup', function () { pressed = false; });
        bind(global, 'pointercancel', function () { pressed = false; });
    }

    function shakeSupported() {
        return typeof global.DeviceMotionEvent !== 'undefined';
    }

    /* iOS 13+ 必须在用户手势的同步调用栈里申请权限，按钮点击时直接调本函数 */
    function enableShake(opts) {
        var DME = global.DeviceMotionEvent;
        if (!DME) return Promise.resolve(false);
        var attach = function () {
            if (shaking) return true;
            shaking = true;
            lastAcc = null;
            bind(global, 'devicemotion', function (e) {
                if (!opts.onStep) return;
                var a = e.accelerationIncludingGravity || e.acceleration;
                if (!a) return;
                var cur = { x: a.x || 0, y: a.y || 0, z: a.z || 0 };
                if (lastAcc) {
                    var d = Math.abs(cur.x - lastAcc.x) + Math.abs(cur.y - lastAcc.y) + Math.abs(cur.z - lastAcc.z);
                    var now = Date.now();
                    /* 阈值 12：手机轻摇即可触发；120ms 冷却防抖 */
                    if (d > 12 && now - lastShake > 120) {
                        lastShake = now;
                        opts.onStep('neutral', 'shake');
                    }
                }
                lastAcc = cur;
            });
            return true;
        };
        if (typeof DME.requestPermission === 'function') {
            return DME.requestPermission().then(function (res) {
                return res === 'granted' ? attach() : false;
            }).catch(function () { return false; });
        }
        return Promise.resolve(attach());
    }

    function destroy() {
        for (var i = 0; i < listeners.length; i++) {
            listeners[i][0].removeEventListener(listeners[i][1], listeners[i][2]);
        }
        listeners = [];
        shaking = false;
    }

    PG.Input = { init: init, shakeSupported: shakeSupported, enableShake: enableShake, destroy: destroy };
})(window);
