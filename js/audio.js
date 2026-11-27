/* ==========================================================================
   audio.js —— WebAudio 合成 8-bit 音效（无音频文件、无外部请求）
   必须在用户手势后 init()，以符合浏览器自动播放策略
   ========================================================================== */
(function (global) {
    'use strict';
    var PG = global.PG = global.PG || {};
    var ctx = null;
    var enabled = true;

    /* 每个音效是一串 [频率, 时长, 音量, 波形] 的方波音符 */
    var SOUNDS = {
        step:   [[520, 0.045, 0.035]],
        star:   [[660, 0.07, 0.055], [880, 0.09, 0.055]],
        gift:   [[523, 0.07, 0.06], [659, 0.07, 0.06], [784, 0.13, 0.06]],
        heart:  [[784, 0.10, 0.05], [1046, 0.13, 0.05]],
        hit:    [[220, 0.12, 0.07, 'sawtooth'], [130, 0.18, 0.07, 'sawtooth']],
        fever:  [[523, 0.08, 0.06], [659, 0.08, 0.06], [784, 0.08, 0.06], [1046, 0.20, 0.065]],
        count:  [[440, 0.09, 0.055]],
        go:     [[880, 0.20, 0.07]],
        finish: [[523, 0.10, 0.06], [659, 0.10, 0.06], [784, 0.10, 0.06], [1046, 0.30, 0.07]],
        fail:   [[392, 0.14, 0.06], [294, 0.18, 0.06], [196, 0.28, 0.06]],
        start:  [[660, 0.10, 0.05]]
    };

    function init() {
        if (ctx) {
            if (ctx.state === 'suspended' && ctx.resume) { try { ctx.resume(); } catch (e) { /* noop */ } }
            return;
        }
        var AC = global.AudioContext || global.webkitAudioContext;
        if (!AC) return;
        try { ctx = new AC(); } catch (e) { ctx = null; }
    }

    function note(freq, dur, vol, type, at) {
        if (!ctx) return;
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = type || 'square';
        osc.frequency.setValueAtTime(freq, at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.linearRampToValueAtTime(vol, at + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(at);
        osc.stop(at + dur + 0.02);
    }

    PG.Audio = {
        init: init,
        isEnabled: function () { return enabled; },
        setEnabled: function (v) {
            enabled = !!v;
            if (enabled) init();
            return enabled;
        },
        play: function (name) {
            if (!enabled) return;
            init();
            if (!ctx) return;
            var seq = SOUNDS[name];
            if (!seq) return;
            var t = ctx.currentTime + 0.005;
            for (var i = 0; i < seq.length; i++) {
                var n = seq[i];
                note(n[0], n[1], n[2], n[3], t);
                t += n[1] * 0.85;
            }
        }
    };
})(window);
