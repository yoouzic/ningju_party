/* ==========================================================================
   net.js —— 晚会互动系统统一 API 客户端
   · 线上（http/https）：服务端权威，所有成绩/名次/发奖由服务端决定
   · file:// 或服务端不可达：练习模式，成绩不计入榜单，页面会明确标注
   ========================================================================== */
(function (global) {
    'use strict';
    var PG = global.PG = global.PG || {};
    var API = '/pixel-rush/api/';
    var KEY_P = 'ningju.player.v2';
    var KEY_A = 'ningju.admin.v2';
    var KEY_D = 'ningju.device.v2';

    var state = { mode: 'unknown', player: null, token: '', adminToken: '', status: null };

    function read(key, fallback) {
        try { var v = global.localStorage && global.localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
        catch (e) { return fallback; }
    }
    function write(key, val) {
        try { if (global.localStorage) global.localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* noop */ }
    }
    function device() {
        var d = read(KEY_D, '');
        if (!d) { d = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); write(KEY_D, d); }
        return d;
    }

    function request(route, opts) {
        opts = opts || {};
        var init = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: {} };
        var token = opts.admin ? state.adminToken : state.token;
        if (token) init.headers['Authorization'] = 'Bearer ' + token;
        if (opts.body) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(opts.body);
        }
        var timer = 0;
        if (global.AbortController) {
            var ctrl = new global.AbortController();
            init.signal = ctrl.signal;
            timer = global.setTimeout(function () { ctrl.abort(); }, 6000);
        }
        return global.fetch(API + route, init).then(function (r) {
            if (timer) global.clearTimeout(timer);
            if (!r.ok) {
                return r.json().catch(function () { return {}; }).then(function (d) {
                    var e = new Error(d.error || ('HTTP ' + r.status));
                    e.status = r.status;
                    throw e;
                });
            }
            return r.json();
        }, function (e) {
            if (timer) global.clearTimeout(timer);
            throw e;
        });
    }

    state.player = read(KEY_P, null);
    state.token = state.player ? (state.player.token || '') : '';
    state.adminToken = read(KEY_A, '');

    PG.Net = {
        API: API,
        device: device,
        getMode: function () { return state.mode; },
        isOnline: function () { return state.mode === 'online'; },
        getPlayer: function () { return state.player; },
        getToken: function () { return state.token; },
        getStatus: function () { return state.status; },
        /* 服务端重建数据库 / 手动更换身份时清掉本机凭证 */
        forget: function () { state.player = null; state.token = ''; write(KEY_P, ''); },

        detect: function () {
            if (!global.fetch || !/^https?:$/.test(global.location.protocol)) {
                state.mode = 'practice';
                return Promise.resolve('practice');
            }
            return request('status').then(function (s) {
                state.mode = 'online';
                state.status = s;
                return 'online';
            }).catch(function () {
                state.mode = 'practice';
                return 'practice';
            });
        },

        status: function () {
            if (state.mode !== 'online') return Promise.resolve(null);
            return request('status').then(function (s) { state.status = s; return s; })
                .catch(function () { return null; });
        },

        join: function (name, code) {
            if (state.mode !== 'online') {
                state.player = { id: 'practice', name: name || '练习玩家', code: '', card_no: '---' };
                return Promise.resolve({ player: state.player, round: null });
            }
            return request('join', { body: { name: name, code: code || '', device: device() } })
                .then(function (d) {
                    state.token = d.token;
                    state.player = { id: d.player.id, name: d.player.name, code: d.player.code,
                                     card_no: d.player.card_no, token: d.token };
                    write(KEY_P, state.player);
                    return d;
                });
        },

        step: function (n) {
            if (state.mode !== 'online') return Promise.resolve(null);
            return request('step', { body: { steps: n } }).catch(function () { return null; });
        },

        board: function (kind) {
            if (state.mode !== 'online') return Promise.resolve(null);
            return request('board' + (kind ? '?kind=' + kind : '')).catch(function () { return null; });
        },

        quizQuestions: function () {
            if (state.mode !== 'online') return Promise.resolve(null);
            return request('quiz/questions').catch(function () { return null; });
        },
        quizSubmit: function (answers) {
            if (state.mode !== 'online') return Promise.resolve(null);
            return request('quiz/submit', { body: { answers: answers } }).catch(function (e) {
                return { error: e.message };
            });
        },

        qrUrl: function (absoluteUrl) {
            return API + 'qrcode?url=' + encodeURIComponent(absoluteUrl);
        },

        /* ---------------- 主持人控制台 ---------------- */
        adminLogin: function (password) {
            if (state.mode !== 'online') return Promise.resolve({ error: '需要连接晚会服务端' });
            return request('admin/login', { body: { password: password } })
                .then(function (d) { state.adminToken = d.token; write(KEY_A, d.token); return d; })
                .catch(function (e) { return { error: e.message }; });
        },
        adminState: function () {
            if (state.mode !== 'online' || !state.adminToken) return Promise.resolve(null);
            return request('admin/state', { admin: true }).catch(function () { return null; });
        },
        adminPost: function (route, data) {
            if (state.mode !== 'online' || !state.adminToken) return Promise.resolve({ error: '未登录' });
            return request('admin/' + route, { body: data || {}, admin: true })
                .catch(function (e) { return { error: e.message }; });
        },
        adminLogout: function () { state.adminToken = ''; write(KEY_A, ''); }
    };
})(window);
