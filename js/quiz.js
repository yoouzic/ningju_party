/* ==========================================================================
   quiz.js —— ② 线上答题竞速：身份 / 轮询轮次 / 拉题渲染 / 提交 / 答题榜
   ----------------------------------------------------------------------------
   · 判分、名次、发奖全部由 server.py 决定，本页只提交「选项文本」。
   · 题目通过 quiz/questions 下发，响应里不含答案；多选用 | 连接选项文本。
   · 服务端下发的文本一律经 textContent 写入，不经过任何 HTML 解析。
   ========================================================================== */
(function (global) {
    'use strict';
    var PG = global.PG = global.PG || {};
    var U = PG.Utils;

    function $(id) { return global.document.getElementById(id); }
    function show(el, yes) { if (el) el.classList.toggle('hidden', !yes); }
    function clearNode(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

    function boot() {
        var doc = global.document;
        var el = {
            modeBadge: $('mode-badge'),
            headerPlayer: $('header-player'),
            partyState: $('party-state'),
            loginForm: $('login-form'),
            inputName: $('player-name'),
            inputCode: $('player-code'),
            btnLogin: $('btn-login'),
            identity: $('identity'),
            whoName: $('who-name'),
            whoCard: $('who-card'),
            btnChange: $('btn-change'),
            authMsg: $('auth-msg'),
            roundState: $('round-state'),
            roundTime: $('round-time'),
            myRank: $('my-rank'),
            statusText: $('status-text'),
            quizHint: $('quiz-hint'),
            quizForm: $('quiz-form'),
            quizList: $('quiz-list'),
            btnSubmit: $('btn-submit'),
            quizResult: $('quiz-result'),
            resultCorrect: $('result-correct'),
            resultElapsed: $('result-elapsed'),
            resultRank: $('result-rank'),
            resultNote: $('result-note'),
            board: $('quiz-board')
        };
        if (!el.loginForm || !el.quizForm || !el.board) return;

        var online = false;
        var busyLogin = false;
        var lastRoundId = 0;          /* 已渲染题目的答题轮次 */
        var submittedRoundId = 0;     /* 本机确认已提交的轮次 */
        var currentRound = null;      /* 最近一次 status 的 round */
        var questions = [];
        var lastResult = null;        /* {correct,total,elapsed_ms,rank} */
        var deadline = 0;
        var timeUp = false;
        var loadingRoundId = 0;
        var pollTimer = 0;
        var submittingRoundId = 0;    /* 正在提交的轮次，0 表示空闲 */
        var pollSeq = 0;              /* 状态轮询序号：旧响应不得覆盖新响应 */
        var pollBusy = false;         /* 慢网下不叠加轮询请求 */
        var lastLoginAt = 0;          /* 最近一次登录成功的时间戳 */
        var lastBoardSig = '';        /* 答题榜内容签名，避免 aria-live 重复播报 */

        /* ---------------------------------------------------------------- 通用 UI */
        function setPartyBar(kind, text) {
            var cls = 'party-bar';
            if (kind === 'running') cls += ' party-bar--running';
            else if (kind === 'closed') cls += ' party-bar--closed';
            else if (kind === 'offline') cls += ' party-bar--offline';
            else if (kind === 'error') cls += ' party-bar--error';
            else cls += ' party-bar--waiting';
            /* 状态未变化时不写入，避免 aria-live 每 1.5s 重复播报 */
            if (el.partyState.className === cls && el.partyState.textContent === text) return;
            el.partyState.className = cls;
            el.partyState.textContent = text;
        }

        function setAuthMsg(text, kind) {
            el.authMsg.textContent = text || '';
            el.authMsg.className = 'party-msg' + (kind ? ' party-msg--' + kind : '');
        }

        function setHint(text, kind) {
            el.quizHint.textContent = text || '';
            el.quizHint.className = 'sub' + (kind === 'err' ? ' is-err' : (kind === 'ok' ? ' is-ok' : ''));
        }

        function setLoginEnabled(enabled) {
            el.inputName.disabled = !enabled;
            el.inputCode.disabled = !enabled;
            el.btnLogin.disabled = !enabled;
        }

        function syncIdentity(player) {
            var signed = !!(player && player.id);
            el.headerPlayer.textContent = signed ? (player.name || '信息员') : '未登录';
            el.whoName.textContent = signed ? (player.name || '信息员') : '—';
            el.whoCard.textContent = '刮刮乐编号：' + (signed && player.card_no ? player.card_no : '---');
            show(el.loginForm, !signed);
            show(el.identity, signed);
        }

        /* ---------------------------------------------------------------- 答题榜 */
        function boardEmpty(text) {
            clearNode(el.board);
            var li = doc.createElement('li');
            li.className = 'party-empty';
            li.textContent = text;
            el.board.appendChild(li);
        }

        function boardSignature(st) {
            var board = st && st.board;
            if (!board || board.kind !== 'quiz') return 'none';
            var entries = board.entries || [];
            var meId = st.me && st.me.id ? st.me.id : '';
            var n = Math.min(10, entries.length);
            var parts = ['quiz', meId];
            for (var i = 0; i < n; i++) {
                var e = entries[i];
                parts.push([e.player_id, e.rank, e.name, e.score, e.total, e.elapsed].join(','));
            }
            return parts.join('|');
        }

        function renderBoard(st) {
            var board = st && st.board;
            /* 内容未变化则跳过重建，避免 aria-live 列表反复播报 */
            var sig = boardSignature(st);
            if (sig === lastBoardSig) return;
            lastBoardSig = sig;
            if (!board || board.kind !== 'quiz') {
                boardEmpty('当前不是答题环节，答题榜暂未生成');
                return;
            }
            var entries = board.entries || [];
            if (!entries.length) {
                boardEmpty('还没有人提交，答题后这里会显示前 10 名');
                return;
            }
            clearNode(el.board);
            var meId = st.me && st.me.id ? st.me.id : '';
            var n = Math.min(10, entries.length);
            for (var i = 0; i < n; i++) {
                var e = entries[i];
                var row = doc.createElement('li');
                if (meId && e.player_id === meId) row.className = 'is-me';

                var no = doc.createElement('b');
                no.className = 'num';
                no.textContent = U.pad2(e.rank || (i + 1));

                var name = doc.createElement('span');
                name.className = 'grow';
                name.textContent = e.name || '信息员';

                var score = doc.createElement('span');
                score.className = 'num';
                score.textContent = (Number(e.score) || 0) + '/' + (Number(e.total) || 0);

                var time = doc.createElement('span');
                time.className = 'muted';
                var ms = Number(e.elapsed);
                if (!isFinite(ms) || ms < 0) ms = 0;
                time.textContent = (ms / 1000).toFixed(1) + ' 秒';

                row.appendChild(no);
                row.appendChild(name);
                row.appendChild(score);
                row.appendChild(time);
                el.board.appendChild(row);
            }
        }

        /* ---------------------------------------------------------------- 题目渲染 */
        function renderQuestions(list) {
            clearNode(el.quizList);
            for (var i = 0; i < list.length; i++) {
                var q = list[i];
                var multi = q.qtype === '多选';

                var card = doc.createElement('div');
                card.className = 'quiz-q';

                var head = doc.createElement('div');
                head.className = 'quiz-q__head';

                var no = doc.createElement('span');
                no.className = 'quiz-q__no';
                no.textContent = '第 ' + (q.order_no || (i + 1)) + ' 题';

                var type = doc.createElement('span');
                type.className = 'quiz-q__type';
                type.textContent = multi ? '多选' : '单选';

                head.appendChild(no);
                head.appendChild(type);

                var prompt = doc.createElement('p');
                prompt.className = 'quiz-q__prompt';
                prompt.textContent = q.prompt || '';

                var opts = doc.createElement('div');
                opts.className = 'quiz-opts';
                var options = q.options || [];
                for (var j = 0; j < options.length; j++) {
                    var label = doc.createElement('label');
                    label.className = 'quiz-opt';

                    var input = doc.createElement('input');
                    input.type = multi ? 'checkbox' : 'radio';
                    input.name = 'q-' + q.id;
                    input.value = String(options[j]);

                    var text = doc.createElement('span');
                    text.textContent = String(options[j]);

                    label.appendChild(input);
                    label.appendChild(text);
                    opts.appendChild(label);
                }

                card.appendChild(head);
                card.appendChild(prompt);
                card.appendChild(opts);
                el.quizList.appendChild(card);
            }
        }

        function setFormDisabled(disabled) {
            var inputs = el.quizList.querySelectorAll('input');
            for (var i = 0; i < inputs.length; i++) inputs[i].disabled = disabled;
            el.btnSubmit.disabled = disabled;
        }

        function resetQuizUI() {
            lastRoundId = 0;
            submittedRoundId = 0;
            submittingRoundId = 0;
            questions = [];
            lastResult = null;
            deadline = 0;
            timeUp = false;
            clearNode(el.quizList);
            show(el.quizForm, false);
            show(el.quizResult, false);
            el.btnSubmit.disabled = false;
            el.btnSubmit.textContent = '提交答案';
            el.resultCorrect.textContent = '--';
            el.resultElapsed.textContent = '--';
            el.resultRank.textContent = '待结算';
            el.resultNote.textContent = '等待主持人结算';
            el.roundTime.textContent = '--';
            el.myRank.textContent = '--';
        }

        function resetQuizIfNeeded() {
            if (lastRoundId || questions.length || submittedRoundId || submittingRoundId || lastResult) resetQuizUI();
        }

        function showResult(res, round) {
            if (!res) return;
            lastResult = res;
            var total = typeof res.total === 'number' ? res.total : questions.length;
            var correct = typeof res.correct === 'number' ? res.correct : 0;
            var ms = Number(res.elapsed_ms);
            if (!isFinite(ms) || ms < 0) ms = 0;
            round = round || currentRound;
            var locked = !!(round && round.kind === 'quiz' &&
                (round.status === 'closed' || round.status === 'void'));
            el.resultCorrect.textContent = correct + '/' + total;
            el.resultElapsed.textContent = (ms / 1000).toFixed(1) + ' 秒';
            el.resultRank.textContent = res.rank
                ? ('第 ' + res.rank + ' 名' + (locked ? '' : '（暂定）'))
                : '待结算';
            el.resultNote.textContent = locked ? '名次已锁定，请查看大屏领奖' : '等待主持人结算';
            show(el.quizResult, true);
            show(el.quizForm, questions.length > 0);
            setFormDisabled(true);
            el.btnSubmit.textContent = '已提交';
        }

        /* ---------------------------------------------------------------- 计时 */
        function tickClock() {
            if (!deadline) return;
            var left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            el.roundTime.textContent = String(left);
            if (left > 0 || timeUp) return;
            timeUp = true;
            if (currentRound && currentRound.kind === 'quiz' && currentRound.status === 'running' &&
                PG.Net.getPlayer() && submittedRoundId !== currentRound.id) {
                el.statusText.textContent = '时间到，请提交';
            }
        }

        /* ---------------------------------------------------------------- 轮询 */
        function quizResultOf(st) {
            var res = st && st.me ? st.me.result : null;
            if (!res) return null;
            if (res.kind === 'quiz') return res;
            if (res.kind) return null;   /* 其他环节的结果不属于答题 */
            /* 后端增量字段偶发缺少 kind：只要带有答题计分字段就接受 */
            return (typeof res.correct === 'number' && typeof res.total === 'number') ? res : null;
        }

        /* st.me.result 是增量字段，可能缺失：退回榜单里自己的成绩 */
        function boardResultOf(st) {
            if (!st || !st.me || !st.board || st.board.kind !== 'quiz' || !st.board.entries) return null;
            for (var i = 0; i < st.board.entries.length; i++) {
                var e = st.board.entries[i];
                if (e.player_id !== st.me.id) continue;
                var ms = Number(e.elapsed);
                if (!isFinite(ms) || ms < 0) ms = 0;
                return {
                    correct: Number(e.score) || 0,
                    total: Number(e.total) || 0,
                    elapsed_ms: ms,
                    rank: e.rank || (i + 1)
                };
            }
            return null;
        }

        function findMyRank(st, res) {
            if (!st || !st.me) return 0;
            return res && res.rank ? res.rank : 0;
        }

        function applyStatus(st) {
            if (!st) return;
            var saved = PG.Net.getPlayer();

            /* 登录刚完成时，忽略尚未携带新 token 的迟到状态，避免误清刚登录的凭证 */
            if (saved && !st.me && Date.now() - lastLoginAt < 2500) return;

            currentRound = st.round || null;

            /* 有本机凭证但服务端不认：说明 token 失效 */
            if (saved && !st.me) {
                PG.Net.forget();
                syncIdentity(null);
                resetQuizUI();
                setAuthMsg('登录已失效，请重新登录', 'err');
                saved = null;
            } else if (st.me && saved && !busyLogin) {
                syncIdentity({ id: st.me.id, name: st.me.name, code: st.me.code, card_no: st.me.card_no });
            }

            renderBoard(st);

            var r = st.round;
            var isQuiz = !!(r && r.kind === 'quiz');
            var running = !!(isQuiz && r.status === 'running');
            var ended = !!(isQuiz && (r.status === 'closed' || r.status === 'void'));
            var res = quizResultOf(st) || boardResultOf(st);
            var logged = !!PG.Net.getPlayer();

            el.roundState.textContent = running ? '答题中' : (ended ? '已结束' : '等待');

            if (running) {
                setPartyBar('running', '第②环节 答题进行中');
            } else if (ended) {
                setPartyBar('closed', '第②环节已结束 · 答题榜已锁定');
            } else if (r && r.kind === 'shake' && r.status === 'running') {
                setPartyBar('waiting', '当前为第①环节 摇一摇');
            } else {
                setPartyBar('waiting', '已连接晚会服务端');
            }

            if (!r) {
                deadline = 0;
                timeUp = false;
                resetQuizIfNeeded();
                el.roundTime.textContent = '--';
                el.myRank.textContent = '--';
                el.statusText.textContent = '当前不是答题环节，请回到摇一摇页面或等待主持人开启第②环节';
                setHint('登录后等待主持人开启第②环节');
                return;
            }

            if (!isQuiz) {
                deadline = 0;
                timeUp = false;
                resetQuizIfNeeded();
                el.roundTime.textContent = '--';
                el.myRank.textContent = '--';
                el.statusText.textContent = '当前不是答题环节，请回到摇一摇页面或等待主持人开启第②环节';
                setHint('当前不是答题环节，题目将在主持人开启第②环节后显示');
                return;
            }

            if (!logged) resetQuizIfNeeded();

            if (running) {
                var left = Math.max(0, Number(r.seconds_left) || 0);
                deadline = Date.now() + left * 1000;
                el.roundTime.textContent = String(left);
                if (left > 0) timeUp = false;
            } else {
                deadline = 0;
                timeUp = false;
                el.roundTime.textContent = '--';
            }

            var rank = findMyRank(st, res);
            if (rank) el.myRank.textContent = '第 ' + rank + ' 名';
            else if (submittedRoundId === r.id || res) el.myRank.textContent = '待结算';
            else el.myRank.textContent = '--';

            if (!logged) {
                el.myRank.textContent = '--';
                show(el.quizForm, false);
                show(el.quizResult, false);
                setHint('请先登录后答题', 'err');
                el.statusText.textContent = running ? '请先登录后答题' : '本环节已结束，请登录后查看答题榜';
                return;
            }

            if (running) {
                if (submittedRoundId !== r.id && res) submittedRoundId = r.id;

                if (submittedRoundId === r.id) {
                    showResult(res || lastResult || { correct: 0, total: questions.length, elapsed_ms: 0 });
                    setHint('答案已提交，等待主持人结算');
                    el.statusText.textContent = '本环节已提交，等待主持人结算';
                } else if (lastRoundId !== r.id) {
                    if (!loadingRoundId) prepareRound(r.id);
                    else {
                        setHint('正在加载本轮题目…');
                        el.statusText.textContent = '答题进行中，正在加载题目';
                    }
                } else if (submittingRoundId === r.id || submittedRoundId === r.id) {
                    /* 提交中或已提交：轮询不得把表单/按钮重新启用 */
                    show(el.quizForm, questions.length > 0);
                    show(el.quizResult, false);
                    setFormDisabled(true);
                    if (submittingRoundId === r.id) {
                        el.btnSubmit.textContent = '提交中…';
                        setHint('正在提交答案…');
                        el.statusText.textContent = '答题进行中，正在提交答案';
                    } else {
                        el.btnSubmit.textContent = '已提交';
                        setHint('答案已提交，等待主持人结算');
                        el.statusText.textContent = '本环节已提交，等待主持人结算';
                    }
                } else {
                    var hasQuestions = questions.length > 0;
                    show(el.quizForm, hasQuestions);
                    show(el.quizResult, false);
                    setFormDisabled(false);
                    el.btnSubmit.textContent = '提交答案';
                    if (timeUp) el.statusText.textContent = '时间到，请提交';
                    else el.statusText.textContent = '答题进行中，正确数优先，同分比用时';
                    if (hasQuestions) setHint('共 ' + questions.length + ' 题 · 单选选一项，多选可多选');
                    else setHint('本轮未配置题目，请等待主持人处理', 'err');
                }
                return;
            }

            /* 答题轮次已结束（closed / void） */
            deadline = 0;
            timeUp = false;
            el.roundTime.textContent = '--';
            setHint('本环节已结束，答案不能再提交');
            if (res) {
                submittedRoundId = r.id;
                showResult(res);
                el.statusText.textContent = '本环节已结束 · 名次已锁定';
            } else if (submittedRoundId === r.id && lastResult) {
                showResult(lastResult);
                el.statusText.textContent = '本环节已结束 · 等待主持人结算';
            } else {
                show(el.quizForm, false);
                show(el.quizResult, false);
                el.myRank.textContent = '--';
                el.statusText.textContent = '本环节已结束，你没有提交答案';
                setHint('本环节已结束，你没有提交答案');
            }
        }

        function poll() {
            if (!online || pollBusy) return;
            pollBusy = true;
            /* 发出请求时记录序号与凭证：迟到的旧响应不得覆盖新状态或注销新登录 */
            var seq = ++pollSeq;
            var token = PG.Net.getToken();
            PG.Net.status().then(function (st) {
                pollBusy = false;
                if (!st) return;
                if (seq !== pollSeq) return;
                if (PG.Net.getToken() !== token) return;
                applyStatus(st);
            });
        }

        function startPolling() {
            if (pollTimer) return;
            poll();
            pollTimer = global.setInterval(poll, 1500);
        }

        /* ---------------------------------------------------------------- 拉题 */
        function prepareRound(roundId) {
            submittedRoundId = 0;
            lastResult = null;
            questions = [];
            timeUp = false;
            clearNode(el.quizList);
            show(el.quizForm, false);
            show(el.quizResult, false);
            setHint('正在加载本轮题目…');
            el.statusText.textContent = '答题进行中，正在加载题目';
            loadQuestions(roundId);
        }

        function loadQuestions(roundId) {
            if (loadingRoundId) return;
            loadingRoundId = roundId;
            PG.Net.quizQuestions().then(function (data) {
                loadingRoundId = 0;
                if (!data || !data.questions) {
                    setHint('题目加载失败，正在重试…', 'err');
                    el.statusText.textContent = '题目加载失败，正在重试';
                    return;
                }
                /* 换轮次、轮次已结束或退出登录后返回的旧响应直接丢弃 */
                if (!currentRound || currentRound.id !== roundId || currentRound.status !== 'running' ||
                    !PG.Net.getPlayer()) return;
                questions = data.questions;
                lastRoundId = roundId;
                if (!questions.length) {
                    show(el.quizForm, false);
                    setHint('本轮未配置题目，请等待主持人处理', 'err');
                    return;
                }
                renderQuestions(questions);
                show(el.quizResult, false);
                show(el.quizForm, true);
                setFormDisabled(false);
                el.btnSubmit.textContent = '提交答案';
                setHint('共 ' + questions.length + ' 题 · 单选选一项，多选可多选');
                poll();
            }).catch(function () {
                loadingRoundId = 0;
                setHint('题目加载失败，正在重试…', 'err');
            });
        }

        /* ---------------------------------------------------------------- 提交 */
        function collectAnswers() {
            var answers = {};
            var unanswered = [];
            for (var i = 0; i < questions.length; i++) {
                var q = questions[i];
                var inputs = el.quizList.querySelectorAll('input[name="q-' + q.id + '"]');
                var picked = [];
                for (var j = 0; j < inputs.length; j++) {
                    if (inputs[j].checked) picked.push(inputs[j].value);
                }
                answers[String(q.id)] = picked.join('|');
                if (!picked.length) unanswered.push(q.order_no || (i + 1));
            }
            return { answers: answers, unanswered: unanswered };
        }

        function submitFailed(text, submitRound) {
            if (submittingRoundId === submitRound) submittingRoundId = 0;
            setHint(text, 'err');
            if (submittingRoundId) return;   /* 另有提交在进行，不要动按钮 */
            if (!currentRound || currentRound.id === submitRound) {
                el.btnSubmit.disabled = false;
                el.btnSubmit.textContent = '提交答案';
            }
        }

        function onSubmit(e) {
            if (e && e.preventDefault) e.preventDefault();
            if (!online) {
                setAuthMsg('练习模式不支持答题，请连接晚会服务端', 'err');
                return;
            }
            if (!PG.Net.getPlayer()) {
                setAuthMsg('请先登录后答题', 'err');
                return;
            }
            if (!currentRound || currentRound.kind !== 'quiz' || currentRound.status !== 'running') {
                setHint('当前不是答题进行中，不能提交', 'err');
                return;
            }
            if (!questions.length || lastRoundId !== currentRound.id) {
                setHint('题目尚未加载完成，请稍后再试', 'err');
                return;
            }
            if (submittedRoundId === currentRound.id) {
                setHint('本环节已提交，请等待主持人结算');
                return;
            }
            if (submittingRoundId) {
                setHint('正在提交答案，请稍候…');
                return;
            }

            var picked = collectAnswers();
            if (picked.unanswered.length) {
                var ok = global.confirm('还有 ' + picked.unanswered.length + ' 题未作答，确定要提交吗？未作答的题目不计分。');
                if (!ok) return;
            }

            /* 锁定本次提交所属的轮次与凭证，避免返回时被后来的轮询/换轮次带偏 */
            var submitRound = currentRound.id;
            var submitToken = PG.Net.getToken();
            submittingRoundId = submitRound;
            el.btnSubmit.disabled = true;
            el.btnSubmit.textContent = '提交中…';
            setHint('正在提交答案…');

            PG.Net.quizSubmit(picked.answers).then(function (res) {
                if (submittingRoundId === submitRound) submittingRoundId = 0;
                if (!res) {
                    submitFailed('提交失败：无法连接晚会服务端，请稍后重试', submitRound);
                    return;
                }
                if (res.error) {
                    submitFailed('提交失败：' + res.error, submitRound);
                    return;
                }
                if (typeof res.correct !== 'number' || typeof res.total !== 'number') {
                    submitFailed('提交失败：服务端返回数据异常，请稍后重试', submitRound);
                    return;
                }
                if (PG.Net.getToken() !== submitToken) {
                    /* 提交期间已退出或更换身份：结果不属于当前会话 */
                    poll();
                    return;
                }
                var doneRound = (res.round && res.round.id) ? res.round.id : submitRound;
                var result = {
                    correct: res.correct,
                    total: res.total,
                    elapsed_ms: res.elapsed_ms,
                    rank: 0
                };
                submittedRoundId = doneRound;
                lastResult = result;
                if (currentRound && currentRound.id === doneRound) {
                    showResult(result, currentRound);
                    el.myRank.textContent = '待结算';
                    setHint('答案已提交，等待主持人结算', 'ok');
                    el.statusText.textContent = '本环节已提交，等待主持人结算';
                }
                poll();
            }).catch(function () {
                if (submittingRoundId === submitRound) submittingRoundId = 0;
                submitFailed('提交失败：网络异常，请稍后重试', submitRound);
            });
        }

        /* ---------------------------------------------------------------- 登录 / 更换身份 */
        function doLogin(e) {
            if (e && e.preventDefault) e.preventDefault();
            if (!online || busyLogin) return;
            var name = String(el.inputName.value || '').replace(/^\s+|\s+$/g, '');
            var code = String(el.inputCode.value || '').replace(/^\s+|\s+$/g, '');
            if (!name) {
                setAuthMsg('请先填写信息员昵称', 'err');
                el.inputName.focus();
                return;
            }
            busyLogin = true;
            setLoginEnabled(false);
            setAuthMsg('正在登录…');
            PG.Net.join(name, code).then(function () {
                busyLogin = false;
                setLoginEnabled(true);
                var player = PG.Net.getPlayer();
                if (!player) {
                    setAuthMsg('登录失败：未获得服务端身份，请重试', 'err');
                    return;
                }
                syncIdentity(player);
                lastLoginAt = Date.now();
                /* 登录成功文案不能与进行中的答题轮次矛盾 */
                var quizRunning = !!(currentRound && currentRound.kind === 'quiz' &&
                    currentRound.status === 'running');
                setAuthMsg(quizRunning ? '登录成功，答题进行中，请尽快作答' : '登录成功，等待主持人开启第②环节', 'ok');
                lastRoundId = 0;
                submittedRoundId = 0;
                lastResult = null;
                poll();
            }).catch(function (err) {
                busyLogin = false;
                setLoginEnabled(true);
                setAuthMsg('登录失败：' + (err && err.message ? err.message : '请重试'), 'err');
            });
        }

        function changeIdentity() {
            PG.Net.forget();
            syncIdentity(null);
            resetQuizUI();
            if (online) {
                setAuthMsg('已退出当前身份，请重新登录', 'ok');
                poll();
            } else {
                setAuthMsg('练习模式不支持答题，请连接晚会服务端', 'err');
            }
            el.inputName.focus();
        }

        /* ---------------------------------------------------------------- 练习模式 */
        function enterPractice() {
            online = false;
            el.modeBadge.textContent = '练习模式';
            el.modeBadge.className = 'plate plate--quiet';
            setPartyBar('offline', '练习模式 · 不计成绩');
            setAuthMsg('练习模式不支持答题，请连接晚会服务端', 'err');
            setLoginEnabled(false);
            resetQuizUI();
            el.roundState.textContent = '等待';
            el.roundTime.textContent = '--';
            el.myRank.textContent = '--';
            el.statusText.textContent = '练习模式没有答题轮次';
            setHint('练习模式不支持答题，请连接晚会服务端', 'err');
            boardEmpty('练习模式没有答题榜，连接晚会服务端后显示前 10 名');
        }

        /* ---------------------------------------------------------------- 初始化 */
        var icons = doc.querySelectorAll('[data-icon]');
        for (var n = 0; n < icons.length; n++) {
            var node = icons[n];
            PG.Sprites.mount(node, node.getAttribute('data-icon'), parseInt(node.getAttribute('data-scale') || '2', 10));
        }

        var saved = PG.Net.getPlayer();
        if (saved) {
            el.inputName.value = saved.name || '';
            el.inputCode.value = saved.code || '';
        }
        syncIdentity(saved);
        setLoginEnabled(false);
        setPartyBar('waiting', '连接晚会服务端…');
        setHint('正在连接晚会服务端…');
        boardEmpty('正在连接晚会服务端…');

        el.loginForm.addEventListener('submit', doLogin);
        el.quizForm.addEventListener('submit', onSubmit);
        el.btnChange.addEventListener('click', changeIdentity);
        doc.addEventListener('visibilitychange', function () {
            if (!doc.hidden) poll();
        });
        global.setInterval(tickClock, 1000);

        PG.Net.detect().then(function (mode) {
            if (mode !== 'online') {
                enterPractice();
                return;
            }
            online = true;
            el.modeBadge.textContent = '全场实时';
            el.modeBadge.className = 'plate plate--online';
            setLoginEnabled(true);
            setPartyBar('waiting', '已连接晚会服务端');
            setHint('登录后等待主持人开启第②环节');
            el.statusText.textContent = '已连接晚会服务端，等待第②环节';
            startPolling();
        }).catch(function () {
            enterPractice();
        });
    }

    if (global.document.readyState === 'loading') {
        global.document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})(window);
