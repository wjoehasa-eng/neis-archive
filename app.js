/* Y공작소 아카이브 · 2025+2026 나이스 플레이북 (껍데기 PWA)
 * ────────────────────────────────────────────────────────────
 * 이 파일에는 게시글·댓글 등 실제 데이터가 한 줄도 없다.
 * 데이터는 ① 내 비공개 구글 드라이브(Apps Script 연결 주소) 또는
 *            ② 사용자가 고른 로컬 JSON 파일로만 들어오고,
 *            IndexedDB(이 기기)에만 담긴다.
 *
 * v9: 한 달 안에서 [종합(25+26) | 2026년 | 2025년] 을 전환해 본다.
 *     카드·플레이북에 연도 배지를 붙여 출처 연도를 구분한다.
 */
(function () {
  'use strict';

  var LS_URL = 'na.bridge', LS_KEY = 'na.key', LS_SYNC = 'na.lastSyncMeta', LS_PBFOLD = 'na.pbFold',
      LS_YEAR = 'na.year';
  var DB_NAME = 'neis-archive', STORE = 'kv', REC = 'archive';
  var AUTO_MS = 30 * 60 * 1000;           // 30분 지나면 조용히 새로 받기
  var MAX_KB = 60 * 1024;                 // 받는 파일 상한(60MB)

  var DATA = null, MONTHS = [], YEARS = [], MS = {}, BYID = Object.create(null), HAY = new Map();
  var CMETA = Object.create(null), CARDS = [], TOPICMETA = Object.create(null);
  var SEVR = { critical: 3, caution: 2, tip: 1 };
  var SEVLBL = { critical: '🔴 사고주의', caution: '🟡 예외주의', tip: '🟢 단순팁' };
  var ROLLBL = { homeroom: '담임', admin: '부장·관리자', all: '공통' };
  var S = { month: 'all', year: 'all', sev: 'all', role: 'all', ms: false, topic: '', q: '', sort: 'sev' };
  var lastMeta = null, syncing = false;

  window.__naErrors = [];
  window.__naVersion = '2026-11-21.9';
  window.addEventListener('error', function (e) { window.__naErrors.push(String((e && e.message) || e)); });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason; window.__naErrors.push('promise: ' + String((r && r.message) || r));
  });

  /* ── 작은 도구 ─────────────────────────────────────────── */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function num(n) { return (n || 0).toLocaleString('ko-KR'); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function nowText(ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function cut(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n).replace(/[ ,·]$/, '') + '…' : s;
  }
  function mLabel(m) { return m ? (+m) + '월' : ''; }                       // m = '01'
  function monOf(a) { return String(a.m || '').slice(5); }                  // 기사 → '01'
  function yrOf(a) { return String(a.m || '').slice(0, 4); }                // 기사 → '2025'
  function dLabel(a) {                                                      // '25.03.15'
    var m = String(a.m || '');
    return m.slice(2, 4) + '.' + m.slice(5) + '.' + String(a.d || '').slice(8, 10);
  }
  function pathText(mp) {
    var segs = String(mp || '').match(/\[([^\]]+)\]/g) || [];
    segs = segs.map(function (s) { return s.slice(1, -1).replace(/\s+/g, ' ').trim(); });
    var out = [];
    segs.forEach(function (s) { if (out[out.length - 1] !== s) out.push(s); });
    return out.join(' › ');
  }
  function pbFolded() { return lsGet(LS_PBFOLD) === '1'; }
  function toast(msg, isErr) {
    var t = $('#toast');
    t.textContent = msg; t.hidden = false;
    t.className = 'toast' + (isErr ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, isErr ? 5200 : 3000);
  }
  function yrBadge(y) {
    return '<span class="tg yr' + (String(y) === '2025' ? ' y25' : '') + '">' + esc(y) + '</span>';
  }
  function statOf(key) {
    var s = MS[key];
    return s ? { a: s.a || 0, c: s.c || 0, k: s.k || 0 } : { a: 0, c: 0, k: 0 };
  }

  /* ── IndexedDB (이 기기 캐시) ──────────────────────────── */
  var memRec = null, idbBroken = false;
  function idbOpen() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) { rej(new Error('no-idb')); return; }
      var r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error || new Error('idb')); };
    });
  }
  function idbDo(mode, fn) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, mode), st = tx.objectStore(STORE);
        var req = fn(st);
        req.onsuccess = function () { res(req.result); };
        req.onerror = function () { rej(req.error); };
      });
    });
  }
  function idbGet(k) { return idbDo('readonly', function (st) { return st.get(k); }); }
  function idbSet(k, v) { return idbDo('readwrite', function (st) { return st.put(v, k); }); }
  function idbDel(k) { return idbDo('readwrite', function (st) { return st.delete(k); }); }

  /* ── 연결 주소(이 기기에만 저장) ───────────────────────── */
  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { /* noop */ } }
  function bridgeUrl() { return lsGet(LS_URL).trim(); }
  function bridgeKey() { return lsGet(LS_KEY).trim(); }

  /* ── 데이터 받기 ──────────────────────────────────────── */
  function callBridge(body, timeoutMs) {
    var url = bridgeUrl();
    if (!url) return Promise.reject(new Error('연결 주소가 없습니다'));
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 90000);
    var payload = { action: body.action || 'get', key: bridgeKey(), app: 'neis-y-archive' };
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).catch(function (err) {
      throw new Error(err && err.name === 'AbortError' ? '응답이 너무 늦어요 (시간 초과)' : '인터넷 연결을 확인해 주세요');
    }).then(function (res) {
      if (!res.ok) throw new Error('연결 주소 응답 ' + res.status + ' · 배포 액세스를 확인하세요');
      return res.text();
    }).then(function (text) {
      clearTimeout(timer);
      if (text.length > MAX_KB * 1024) throw new Error('받은 파일이 너무 큽니다');
      var body2;
      try { body2 = JSON.parse(text); } catch (e) {
        throw new Error('응답을 읽지 못했어요 · 배포 주소(…/exec)와 액세스 권한을 확인하세요');
      }
      if (body2 && body2.ok === false) throw new Error(body2.error || '연결 쪽에서 거부했습니다');
      return body2;
    }, function (err) { clearTimeout(timer); throw err; });
  }
  function bridgeInfo() { return callBridge({ action: 'info' }, 30000); }
  function bridgeGet() {
    return callBridge({ action: 'get' }, 180000).then(function (body) {
      var payload = body;
      if (body && typeof body.text === 'string') {
        try { payload = JSON.parse(body.text); } catch (e) { throw new Error('아카이브 형식이 아닙니다'); }
      } else if (body && body.data) {
        payload = body.data;
      }
      if (!payload || !Array.isArray(payload.articles)) throw new Error('아카이브 형식이 아닙니다');
      return { payload: payload, updated: (body && body.updated) || '', size: (body && body.size) || 0 };
    });
  }

  function saveArchive(payload, source, extra) {
    var s;
    try { s = JSON.stringify(payload); } catch (e) { s = ''; }
    var rec = { json: s, savedAt: Date.now(), source: source, built: payload.built_at || '', bytes: s.length };
    if (extra) { rec.driveUpdated = extra.driveUpdated || ''; rec.driveSize = String(extra.driveSize || ''); }
    memRec = rec;
    if (!idbBroken) return idbSet(REC, rec).catch(function () { idbBroken = true; });
    return Promise.resolve();
  }

  /* ── 데이터 적용 ──────────────────────────────────────── */
  function applyData(payload, meta) {
    if (!payload || !payload.articles) return;
    var first = !DATA;
    DATA = payload;

    MONTHS = (payload.months && payload.months.length) ? payload.months.slice() : ['01'];
    if (String(MONTHS[0]).length > 2) MONTHS = MONTHS.map(function (m) { return m.slice(5); });
    YEARS = (payload.years && payload.years.length) ? payload.years.slice()
      : (function () { var ys = {}; payload.articles.forEach(function (a) { ys[yrOf(a)] = 1; });
          return Object.keys(ys).sort().reverse(); })();
    YEARS = YEARS.map(function (y) { return String(y).slice(0, 4); });

    MS = payload.monthStat || (function () {          // schema 2 호환
      var o = {};
      Object.keys(payload.month_counts || {}).forEach(function (k) {
        o[k] = { a: payload.month_counts[k] || 0 }; o[k].c = (payload.month_comments || {})[k] || 0;
      });
      return o;
    })();

    BYID = Object.create(null); HAY = new Map(); CMETA = Object.create(null);
    TOPICMETA = Object.create(null); CARDS = [];
    payload.articles.forEach(function (a) { BYID[a.i] = a; });
    (payload.topics || []).forEach(function (t) { TOPICMETA[t.n] = t; });
    CMETA = payload.cards || {};
    Object.keys(CMETA).forEach(function (k) {
      var a = BYID[+k]; if (!a) return;
      var m = CMETA[k];
      CARDS.push({ id: +k, a: a, m: m, topic: a.p || '', y: m.y || yrOf(a) });
    });
    CARDS.sort(cardOrder);
    lastMeta = meta || null;

    if (first) {
      S.month = 'all';
      var ly = lsGet(LS_YEAR);
      S.year = ly && (ly === 'all' || YEARS.indexOf(ly) >= 0) ? ly : 'all';
    }
    if (S.month !== 'all' && MONTHS.indexOf(S.month) < 0) S.month = 'all';
    if (S.year !== 'all' && YEARS.indexOf(S.year) < 0) S.year = 'all';
    S.q = ''; var qi = $('#q'); if (qi) qi.value = '';

    renderShell();
    $('#setupPanel').hidden = true;
    $('#content').hidden = false;
    renderAll();
    setState((meta && meta.savedAt ? '불러옴 ' + nowText(meta.savedAt) + ' · ' : '') +
      (meta && meta.source === 'file' ? '내 JSON 파일' : '드라이브'), 'ok');
  }

  function cardOrder(x, y) {
    return (SEVR[y.m.sv] || 0) - (SEVR[x.m.sv] || 0) || (y.a.n - x.a.n) || (y.a.i - x.a.i);
  }

  function topicColor(name) { var t = TOPICMETA[name]; return (t && t.c) || '#9aa0ac'; }

  /* ── 셸(정적 영역) ────────────────────────────────────── */
  function syncTopbarHeight() {
    var root = document.documentElement.style;
    var h = function (sel) { var el = $(sel); return el ? Math.round(el.getBoundingClientRect().height) : 0; };
    root.setProperty('--tb-h', h('.topbar') + 'px');
    root.setProperty('--ms-h', h('#mstrip') + 'px');
    root.setProperty('--dk-h', h('#deckbar') + 'px');
  }
  function barPad() {
    var cs = window.getComputedStyle(document.documentElement);
    var v = function (k) { return parseFloat(cs.getPropertyValue(k)) || 0; };
    return v('--tb-h') + v('--ms-h') + v('--dk-h') + 10;
  }

  function renderShell() {
    syncTopbarHeight();
    renderYears();
    renderMonths();
    renderPlaybook();
    renderRows();
    renderTopics();
    renderFooter();
  }

  /* ── 연도 전환 탭 ─────────────────────────────────────── */
  function cardCountMonthYear(m, y) {
    var any = (y == null || y === 'all');
    return CARDS.filter(function (c) {
      return (m === 'all' || monOf(c.a) === m) && (any || String(c.y) === String(y));
    }).length;
  }
  function yearAvail(y) {
    if (S.month === 'all') {
      return CARDS.some(function (c) { return String(c.y) === String(y); });
    }
    return statOf(y + '-' + S.month).a > 0 || cardCountMonthYear(S.month, y) > 0;
  }
  function renderYears() {
    var box = $('#yrseg');
    if (!box) return;
    if (S.year !== 'all' && !yearAvail(S.year)) S.year = 'all';
    var h = [];
    h.push('<button class="yrbtn' + (S.year === 'all' ? ' on' : '') + '" type="button" role="tab" data-y="all" aria-selected="' +
      (S.year === 'all') + '">종합(25+26)<span class="n">' +
      (S.month === 'all' ? CARDS.length : cardCountMonthYear(S.month)) + '</span></button>');
    YEARS.forEach(function (y) {
      var n = S.month === 'all' ? cardCountMonthYear('all', y) : cardCountMonthYear(S.month, y);
      var off = !yearAvail(y);
      h.push('<button class="yrbtn' + (S.year === String(y) ? ' on' : '') + '" type="button" role="tab" data-y="' + y + '"' +
        ' aria-selected="' + (S.year === String(y)) + '"' + (off ? ' disabled' : '') +
        ' title="' + y + '년 카드 ' + n + '장' + (off ? ' · 이 달 자료 없음' : '') + '">' +
        y + '년<span class="n">' + n + '</span></button>');
    });
    box.innerHTML = h.join('');
  }

  /* 월 스트립 숫자는 ‘대표 카드 수’(연도 필터 반영). 원문 글 수는 툴팁에. */
  function renderMonths() {
    var html = ['<div class="mstrip-in">'];
    var allCnt = S.year === 'all' ? CARDS.length : cardCountMonthYear('all', S.year);
    html.push('<button class="mbtn all' + (S.month === 'all' ? ' on' : '') + '" type="button" data-m="all"' +
      ' title="전체 카드 ' + allCnt + '장 · 원문 ' + num(DATA.articles.length) + '건">' +
      '<b>전체</b><span>' + allCnt + '</span></button>');
    MONTHS.forEach(function (m) {
      var n = S.year === 'all' ? cardCountMonthYear(m) : cardCountMonthYear(m, S.year);
      var tip = (+m) + '월';
      YEARS.forEach(function (y) {
        var st = statOf(y + '-' + m);
        if (st.a) tip += ' · ' + y + ' 글 ' + num(st.a) + '건/댓글 ' + num(st.c) + '개/카드 ' + cardCountMonthYear(m, y) + '장';
      });
      html.push('<button class="mbtn' + (S.month === m ? ' on' : '') + '" type="button" data-m="' + m + '" title="' + tip + '">' +
        '<b>' + (+m) + '월</b><span>' + num(n) + '</span></button>');
    });
    html.push('</div>');
    $('#mstrip').innerHTML = html.join('');
  }

  function foldBtn(folded) {
    return '<button class="pbfold" type="button" id="btnPbFold" aria-expanded="' + (folded ? 'false' : 'true') + '">' +
      (folded ? '펼치기 ▾' : '접기 ▴') + '</button>';
  }

  function chipLabel(id, a) {
    var m = CMETA[id] || {};
    return m.ch || m.t || a.t;
  }

  function playbooksOf(m) {
    var out = [];
    var yl = S.year === 'all' ? YEARS : [S.year];
    yl.forEach(function (y) {
      var pb = (DATA.monthlyPlaybooks || {})[y + '-' + m];
      if (pb) out.push({ y: String(y), pb: pb });
    });
    return out;
  }

  function pbSection(o, idx, folded) {
    var pb = o.pb, y = o.y;
    var steps = pb.steps.map(function (s, i) {
      var chips = (s[2] || []).map(function (id) {
        var a = BYID[id]; if (!a) return '';
        return '<button class="mini-chip" type="button" data-jump="' + id + '" title="' + esc((CMETA[id] || {}).t || a.t) + '">' + esc(chipLabel(id, a)) + '</button>';
      }).join('');
      return '<li class="step"><div class="step-top"><span class="step-no">' + (i + 1) + '</span><span class="step-line"></span></div>' +
        '<h3>' + esc(s[0]) + '</h3><p>' + esc(s[1]) + '</p>' +
        (chips ? '<div class="step-cards">' + chips + '</div>' : '') + '</li>';
    }).join('');
    var mines = pb.pitfalls.map(function (p) {
      var id = (p[2] || [])[0];
      var a = id ? BYID[id] : null;
      return '<li><div><b>' + esc(p[0]) + '</b><span>' + esc(p[1]) + '</span></div>' +
        (a ? '<button class="mini-chip" type="button" data-jump="' + id + '" title="' + esc((CMETA[id] || {}).t || a.t) + '">' + esc(chipLabel(id, a)) + '</button>' : '<span></span>') + '</li>';
    }).join('');
    var st = statOf(y + '-' + (S.month === 'all' ? '01' : S.month));
    var arts = S.month === 'all' ? 0 : st.a;
    var cmts = S.month === 'all' ? 0 : st.c;
    var cards = cardCountMonthYear(S.month === 'all' ? 'all' : S.month, y);
    return '<div class="pb-sec">' +
      (idx ? '<div class="pb-yhead"><b>' + y + '년</b><span class="yline"></span><em>' + esc(pb.label) + '</em></div>' : '') +
      '<div class="pb-head">' +
      '<div class="pb-top"><div class="pb-kick">' + esc(mLabel(S.month)) + ' 업무 흐름 · ' + y + '</div>' +
      (idx === 0 ? foldBtn(folded) : '') + '</div>' +
      '<h1><small>' + esc(mLabel(S.month)) + '에 할 일 · ' + y + '년</small>' + esc(pb.label) + '</h1>' +
      '<p class="pb-sum">' + esc(pb.summary) + '</p>' +
      (S.month !== 'all'
        ? '<p class="pb-sub">' + y + '년 ' + esc(mLabel(S.month)) + ' 원문 글 ' + num(arts) + '건 · 댓글 ' + num(cmts) + '개에서 뽑은 대표 카드 ' + num(cards) + '장</p>'
        : '<p class="pb-sub">' + y + '년 카드 ' + num(cards) + '장</p>') +
      '</div>' +
      '<ol class="flow">' + steps + '</ol>' +
      '<div class="mines" id="mines"><div class="mines-h"><span class="mines-ic">⚠️</span><div>' +
      '<b>이달의 지뢰 ' + pb.pitfalls.length + '</b><em>여기서 미끄러지면 복구가 어렵거나 일이 두 배가 됩니다</em></div></div>' +
      '<ul>' + mines + '</ul></div></div>';
  }

  function renderPlaybook() {
    var box = $('#playbook');
    var folded = pbFolded();
    box.classList.toggle('folded', folded);
    if (S.month === 'all') { box.innerHTML = yearHtml(folded); return; }
    var list = playbooksOf(S.month);
    if (!list.length) {
      box.innerHTML = '<div class="pb-head"><div class="pb-kick">' + esc(mLabel(S.month)) + ' 업무 흐름</div>' +
        '<h1>이 달의 플레이북이 아직 없습니다</h1><p class="pb-sum">' + esc(mLabel(S.month)) + ' 자료가 아직 없거나 데이터 양식이 예전 것입니다 — 위의 <b>동기화</b>를 눌러 새 데이터를 받아 주세요.</p></div>';
      return;
    }
    var head = '<div class="pb-head" style="padding-bottom:0"><div class="pb-top"><div class="pb-kick">' +
      esc(mLabel(S.month)) + ' 업무 흐름 · ' +
      (S.year === 'all' ? '2025+2026' : S.year + '년') + '</div></div>' +
      '<h1><small>' + (list.length > 1 ? '두 해를 겹쳐 봅니다 · 연도 탭으로 한 해만 볼 수 있습니다' : '') + '</small>' +
      esc(mLabel(S.month)) + '에 할 일</h1></div>';
    box.innerHTML = head + list.map(function (o, i) { return pbSection(o, i, folded); }).join('');
  }

  function yearHtml(folded) {
    var blocks = [];
    var yl = S.year === 'all' ? YEARS : [S.year];
    yl.forEach(function (y) {
      var items = MONTHS.map(function (m) {
        var pb = (DATA.monthlyPlaybooks || {})[y + '-' + m];
        if (!pb) return '';
        var n = cardCountMonthYear(m, y);
        return '<li><button class="ym" type="button" data-m="' + m + '">' +
          '<b>' + (+m) + '월<em>' + n + '장</em></b>' +
          '<span class="yt">' + esc(pb.label) + '</span>' +
          '<span class="yd">' + esc(cut(pb.summary, 62)) + '</span>' +
          '<span class="yb"><span class="ytag">흐름 ' + pb.steps.length + '단계</span>' +
          '<span class="ytag">지뢰 ' + pb.pitfalls.length + '</span></span></button></li>';
      }).join('');
      if (!items) return;
      blocks.push('<div class="pb-sec"><div class="pb-yhead"><b>' + y + '년</b><span class="yline"></span>' +
        '<em>' + (+MONTHS[0]) + '월부터 ' + (+MONTHS[MONTHS.length - 1]) + '월까지</em></div>' +
        '<ol class="yearflow">' + items + '</ol></div>');
    });
    if (!blocks.length) {
      return '<div class="pb-head"><div class="pb-kick">한 해 업무 흐름</div>' +
        '<h1>플레이북 데이터를 기다리는 중입니다</h1><p class="pb-sum">데이터 양식이 예전 것입니다 — 위의 <b>동기화</b>를 눌러 새 플레이북 데이터를 받아 주세요.</p></div>';
    }
    var s = DATA.source || {};
    return '<div class="pb-head"><div class="pb-top"><div class="pb-kick">' +
      (S.year === 'all' ? '2025+2026 한 해 업무 흐름' : S.year + ' 한 해 업무 흐름') + '</div>' + foldBtn(folded) + '</div>' +
      '<h1><small>달을 고르면 그 달의 순서와 지뢰가 먼저 보입니다</small>' +
      (S.year === 'all' ? '두 해를 나눠서, 달마다 겹쳐 봅니다' : S.year + '년 한 해') + '</h1>' +
      '<p class="pb-sum">본문 ' + num(s.articles) + '건 · 댓글 ' + num(s.comments) + '건에서 뽑은 대표 카드 ' +
      num(CARDS.length) + '장을 경중(🔴 사고주의 / 🟡 예외주의 / 🟢 단순팁)으로 나눴습니다. ' +
      '아래 월 카드를 누르면 그 달의 업무 순서와 지뢰부터 보여 줍니다.</p></div>' +
      blocks.join('');
  }

  function renderFooter() {
    var s = DATA.source || {}, by = s.by_year || {};
    var part = YEARS.map(function (y) {
      var b = by[y] || {};
      return y + '년 본문 ' + num(b.articles) + '건/댓글 ' + num(b.comments) + '건';
    }).join(' · ');
    $('#ftr').innerHTML = 'Y공작소 아카이브 · 본문 ' + num(s.articles) + '건 / 댓글 ' + num(s.comments) +
      '건 · 대표 카드 ' + num(CARDS.length) + '장 · 데이터 기준 ' + esc(DATA.built_at || '') +
      '<br>' + part +
      '<br>이 앱(GitHub Pages)에는 데이터가 없고, 내 구글 드라이브의 비공개 파일에서 이 기기로만 받아 옵니다. ' +
      '카드 제목·1줄 결론·지뢰 표시는 원문 글·댓글을 근거로 정리한 것이고, 메뉴 경로와 공식 표시(매뉴얼 p.)는 ' +
      '2026학년도 경기도 초등학교용 나이스 교무업무 매뉴얼에서 확인된 것만 넣었습니다. 확인되지 않은 사안은 예외로 표시했습니다.';
  }

  /* ── 필터 계산 ────────────────────────────────────────── */
  function inMonth(c) { return S.month === 'all' || monOf(c.a) === S.month; }
  function yearOk(c) { return S.year === 'all' || String(c.y) === String(S.year); }
  function hay(a) {
    var v = HAY.get(a.i);
    if (v) return v;
    var m = CMETA[a.i];
    v = (a.t + ' ' + yrOf(a) + ' ' + (m ? (m.t || '') + ' ' + (m.ch || '') + ' ' + (m.mp || '') + ' ' + (m.one || '') : '') + ' ' +
      (a.bd || '') + ' ' + (a.x || '') + ' ' + (a.b || '') + ' ' + (a.p || '') + ' ' +
      (a.cm || []).map(function (c) { return c.c; }).join(' ')).toLowerCase();
    HAY.set(a.i, v); return v;
  }
  function roleOk(c) {
    if (S.role === 'all') return true;
    return c.m.r === S.role || c.m.r === 'all';
  }
  function deckBase() {
    return CARDS.filter(function (c) {
      return inMonth(c) && yearOk(c) && (!S.topic || c.topic === S.topic) && (!S.ms || c.a.s);
    });
  }

  function renderChips() {
    var base = deckBase();
    var n = { all: base.length, critical: 0, caution: 0, tip: 0, homeroom: 0, admin: 0 };
    base.forEach(function (c) {
      n[c.m.sv] = (n[c.m.sv] || 0) + 1;
      if (c.m.r === 'homeroom' || c.m.r === 'all') n.homeroom++;
      if (c.m.r === 'admin' || c.m.r === 'all') n.admin++;
    });
    var c = function (key, cls, label, cnt, on) {
      return '<button class="chip ' + cls + (on ? ' on' : '') + '" type="button" data-sev="' + key + '">' +
        label + '<span class="n">' + cnt + '</span></button>';
    };
    var h = [];
    h.push(c('all', '', '전체', n.all, S.sev === 'all'));
    h.push(c('critical', 'c-crit', '🔴 사고주의', n.critical, S.sev === 'critical'));
    h.push(c('caution', 'c-warn', '🟡 예외주의', n.caution, S.sev === 'caution'));
    h.push(c('tip', 'c-tip', '🟢 단순팁', n.tip, S.sev === 'tip'));
    h.push('<span class="chip-sep"></span>');
    h.push('<button class="chip' + (S.role === 'homeroom' ? ' on' : '') + '" type="button" data-role="homeroom">담임<span class="n">' + n.homeroom + '</span></button>');
    h.push('<button class="chip' + (S.role === 'admin' ? ' on' : '') + '" type="button" data-role="admin">부장·관리자<span class="n">' + n.admin + '</span></button>');
    h.push('<button class="chip' + (S.ms ? ' on' : '') + '" type="button" data-ms="1">맑은샘 답변</button>');
    if (S.topic) {
      h.push('<button class="chip on" type="button" data-topicclear="1">주제 · ' + esc(cut(S.topic, 14)) + ' ✕</button>');
    }
    $('#chips').innerHTML = h.join('');
  }

  /* ── 카드 ─────────────────────────────────────────────── */
  function visibleCards() {
    var list = deckBase().filter(function (c) {
      return (S.sev === 'all' || c.m.sv === S.sev) && roleOk(c);
    });
    if (S.sort === 'cmt') list.sort(function (x, y) { return y.a.n - x.a.n || cardOrder(x, y); });
    else if (S.sort === 'new') list.sort(function (x, y) { return x.a.d < y.a.d ? 1 : x.a.d > y.a.d ? -1 : cardOrder(x, y); });
    else list.sort(cardOrder);
    return list;
  }

  function cardSrcHtml(a) {
    var src = '';
    src += '<div class="otitle"><b>원문 제목</b>' + esc(a.t) + '</div>';
    if (a.x) src += '<div class="note"><b>정리</b>' + esc(a.x) + '</div>';
    if (a.bc) {
      src += '<div class="quote' + (a.bc.ms ? ' ms' : '') + '"><span class="who">' +
        (a.bc.ms ? '맑은샘 답변' : '댓글') + ' · ' + esc(a.bc.n || '') + ' (' + esc(a.bc.d || '') + ')</span>' +
        esc(a.bc.c) + '</div>';
    }
    if (a.bd) {
      src += '<div class="note"><b>원문 글</b><div class="qbody">' + esc(cut(a.bd, 900)) + '</div></div>';
    }
    if (!src) src = '<p class="mini-note">보관된 원문 요약이 없습니다. 카페 원문에서 확인하세요.</p>';
    src += '<div><a class="srclink" href="' + esc(a.u) + '" target="_blank" rel="noopener">카페 원문 열기 →</a></div>';
    return '<div class="srcbody">' + src + '</div>';
  }

  function cardHtml(c) {
    var a = c.a, m = c.m;
    var tags = yrBadge(c.y) +
      '<span class="sev sev-' + m.sv + '">' + SEVLBL[m.sv] + '</span>' +
      '<span class="tg role">' + ROLLBL[m.r] + '</span>' +
      '<span class="tg topic" title="' + esc(c.topic) + '">' + esc(cut(c.topic, 14)) + '</span>' +
      (m.g === 'gyeonggi' ? '<span class="tg reg-g">경기</span>' : '');
    var mp = m.mp ? '<div class="mp"><span class="mpk">메뉴</span>' + esc(pathText(m.mp)) +
      (m.mpp ? '<span class="mpp">매뉴얼 p.' + m.mpp + '</span>' : '') + '</div>' : '';
    return '<article class="card sev-' + m.sv + '" data-id="' + a.i + '">' +
      '<div class="ctags">' + tags + '</div>' +
      '<h3 class="cq"><a href="' + esc(a.u) + '" target="_blank" rel="noopener">' + esc(m.t || a.t) + '</a></h3>' +
      '<p class="one">' + esc(m.one) + '</p>' +
      mp +
      (m.mn ? '<p class="mn"><b>공식</b>' + esc(m.mn) + '</p>' : '') +
      (m.ex ? '<p class="ex"><b>예외</b>' + esc(m.ex) + '</p>' : '') +
      '<div class="cmeta"><span>' + esc(dLabel(a)) + '</span><span class="dot"></span>' +
      '<span>' + esc(a.b) + '</span><span class="dot"></span>' +
      '<span>댓글 ' + num(a.n) + '</span>' + (a.l ? '<span class="dot"></span><span>♥ ' + num(a.l) + '</span>' : '') +
      (a.s ? '<span class="dot"></span><span class="ms">맑은샘 답변</span>' : '') + '</div>' +
      '<details class="src"><summary>근거 글·댓글 ' + num(a.n) + '개 보기</summary></details>' +
      '</article>';
  }

  function renderDeck() {
    if (!DATA) return;
    renderChips();
    var q = S.q.trim().toLowerCase();
    var searching = !!q;
    $('#cards').hidden = searching;
    $('#searchPanel').hidden = !searching;
    $('#playbook').hidden = searching;
    $('#rowsBox').hidden = searching;
    $('#topicsBox').hidden = searching;
    $('#btnClearQ').hidden = !q;
    if (searching) { renderSearch(q); return; }
    var list = visibleCards();
    $('#cards').innerHTML = list.length ? list.map(cardHtml).join('') :
      '<div class="empty">이 조건에 맞는 카드가 없습니다. 연도·필터를 풀어 보세요.</div>';
    var monthArts = 0, monthCmts = 0;
    if (S.month === 'all') {
      DATA.articles.forEach(function (a) {
        if (S.year === 'all' || yrOf(a) === String(S.year)) { monthArts++; monthCmts += a.n || 0; }
      });
    } else {
      YEARS.forEach(function (y) {
        if (S.year === 'all' || S.year === String(y)) {
          var st = statOf(y + '-' + S.month); monthArts += st.a; monthCmts += st.c;
        }
      });
    }
    var ytxt = S.year === 'all' ? '' : S.year + '년 ';
    $('#countTxt').innerHTML = '카드 <b>' + num(list.length) + '</b>장' +
      (S.month === 'all' ? ' · ' + ytxt + '전체 ' + num(monthArts) + '건' : ' · ' + ytxt + esc(mLabel(S.month)) + ' 글 ' + num(monthArts) + '건');
    barState('카드 ' + num(list.length) + '장');
    window.__naState = {
      articles: DATA.articles.length, cards: CARDS.length, rendered: list.length,
      topics: (DATA.topics || []).length, built: DATA.built_at, month: S.month, year: S.year,
      mode: 'deck', months: MONTHS.length, years: YEARS
    };
  }

  /* ── 검색 결과 ─────────────────────────────────────────── */
  var searchLimit = 40, searchHits = [];
  function renderSearch(q) {
    /* 검색은 달·연도와 상관없이 두 해 전체에서 찾는다(카드 먼저). 결과에 연도 배지가 붙는다. */
    searchHits = DATA.articles.filter(function (a) {
      return hay(a).indexOf(q) >= 0;
    }).sort(function (x, y) {
      var cx = CMETA[x.i] ? 2 : 0, cy = CMETA[y.i] ? 2 : 0;
      return (cy - cx) || (y.n - x.n) || (y.i - x.i);
    });
    var show = searchHits.slice(0, searchLimit);
    var h = ['<div class="shead"><h2>“' + esc(S.q.trim()) + '” 검색 결과</h2>' +
      '<span class="n">' + num(searchHits.length) + '건 · 2025+2026 전체 · 카드 먼저, 댓글 많은 순</span></div>'];
    if (!searchHits.length) {
      h.push('<div class="empty">찾는 내용이 없습니다. 짧은 낱말로 다시 검색해 보세요 (예: 반변경, 생기부, 권한).</div>');
    } else {
      h.push('<div class="foldbody" style="padding:0">' + show.map(rowHtml).join('') + '</div>');
      if (searchHits.length > show.length) {
        h.push('<button class="btn small morebtn" type="button" id="btnMoreHit">더 보기 (' +
          (searchHits.length - show.length) + '건)</button>');
      }
    }
    $('#searchPanel').innerHTML = h.join('');
    $('#countTxt').innerHTML = '검색 <b>' + num(searchHits.length) + '</b>건';
    barState('검색 ' + num(searchHits.length) + '건');
    window.__naState = {
      articles: DATA.articles.length, cards: CARDS.length, topics: (DATA.topics || []).length,
      built: DATA.built_at, month: S.month, year: S.year, mode: 'search', hits: searchHits.length
    };
  }

  /* ── 원문 글 목록 ──────────────────────────────────────── */
  function rowsOfMonth() {
    return DATA.articles.filter(function (a) {
      return (S.month === 'all' || monOf(a) === S.month) && (S.year === 'all' || yrOf(a) === String(S.year));
    }).sort(function (x, y) { return (y.n - x.n) || (y.i - x.i); });
  }

  function rowHtml(a) {
    var meta = CMETA[a.i];
    var preview = meta ? meta.one : (a.x || (a.bc && a.bc.c));
    var note = preview ? '<span class="rn' + (meta ? ' rn-one' : '') + '">' + esc(cut(preview, 150)) + '</span>' : '';
    return '<details class="row" data-id="' + a.i + '">' +
      '<summary><span class="rd">' + esc(dLabel(a)) + '</span>' +
      '<span class="rt"><span class="rb">' + esc(cut(a.p || a.b, 16)) + '</span> ' + esc(meta ? (meta.t || a.t) : a.t) + note + '</span>' +
      '<span class="rm">' + (a.s ? '<span class="ms">맑은샘</span>' : '') +
      (a.pa ? '<span class="pt" title="첫 10개 댓글만 보관">일부</span>' : '') +
      '<span>💬' + num(a.n) + '</span>' + (a.l ? '<span>♥' + num(a.l) + '</span>' : '') + '</span></summary>' +
      '</details>';
  }

  function renderRows() {
    var box = $('#rowsBox');
    if (!box) return;
    if (S.month === 'all') {
      var per = Object.create(null);
      DATA.articles.forEach(function (a) {
        if (S.year !== 'all' && yrOf(a) !== String(S.year)) return;
        per[monOf(a)] = (per[monOf(a)] || 0) + 1;
      });
      box.innerHTML = '<details class="fold"><summary><h2>월별 원문 글</h2>' +
        '<span class="n">' + (S.year === 'all' ? '두 해' : S.year + '년') + ' ' +
        num(Object.keys(per).reduce(function (s, k) { return s + per[k]; }, 0)) +
        '건 · 월을 고르면 그 달 글 목록이 열립니다</span></summary>' +
        '<div class="foldbody"><div class="chips" style="padding:10px 0">' +
        MONTHS.map(function (m) {
          return '<button class="chip" type="button" data-m="' + m + '">' + (+m) + '월<span class="n">' +
            num(per[m] || 0) + '</span></button>';
        }).join('') + '</div></div></details>';
      return;
    }
    var rows = rowsOfMonth();
    box.innerHTML = '<details class="fold"><summary><h2>' + esc(mLabel(S.month)) + ' 원문 글 전체</h2>' +
      '<span class="n">' + (S.year === 'all' ? '두 해 ' : S.year + '년 ') + num(rows.length) + '건 · 댓글 ' +
      num(rows.reduce(function (s, a) { return s + (a.n || 0); }, 0)) + '개</span></summary>' +
      '<div class="foldbody">' + rows.map(rowHtml).join('') + '</div></details>';
  }

  function detailHtml(a) {
    var h = ['<div class="detail">'];
    var m = CMETA[a.i];
    h.push('<div class="otitle"><b>원문 제목 · ' + esc(yrOf(a)) + '</b>' + esc(a.t) + '</div>');
    if (m) h.push('<div class="onetag">' + SEVLBL[m.sv] + ' · ' + esc(m.one) + '</div>');
    if (a.x) h.push('<div class="note"><b>정리</b>' + esc(a.x) + '</div>');
    if (a.bd) h.push('<div class="note"><b>원문 글</b><div class="qbody" style="max-height:none">' + esc(a.bd) + '</div></div>');
    if (a.pa) h.push('<p class="mini-note">※ 이 글은 첫 10개 댓글만 보관되어 있습니다.</p>');
    if (a.cm && a.cm.length) {
      h.push(a.cm.map(function (c) {
        return '<div class="cm' + (c.n === '맑은샘' ? ' best' : '') + '">' +
          '<span class="who">' + esc(c.n) + '</span><span class="cdate">' + esc(c.d) + '</span>' +
          (c.r ? ' <span class="mini-note">답글</span>' : '') + '<div>' + esc(c.c) + '</div></div>';
      }).join(''));
    } else {
      h.push('<p class="mini-note">보관된 댓글이 없습니다.</p>');
    }
    h.push('<div><a class="srclink" href="' + esc(a.u) + '" target="_blank" rel="noopener">카페 원문 열기 →</a></div></div>');
    return h.join('');
  }

  /* ── 주제별 정리 ──────────────────────────────────────── */
  function renderTopics() {
    var box = $('#topicsBox');
    if (!box) return;
    var items = (DATA.topics || []).map(function (t) {
      var mine = CARDS.filter(function (c) { return c.topic === t.n; });
      var n = mine.length;
      var bySev = { critical: 0, caution: 0, tip: 0 };
      mine.forEach(function (c) { bySev[c.m.sv]++; });
      var ycnt = {};
      mine.forEach(function (c) { ycnt[c.y] = (ycnt[c.y] || 0) + 1; });
      var ytxt = YEARS.filter(function (y) { return ycnt[y]; }).map(function (y) { return y + ' ' + ycnt[y]; }).join(' · ');
      return '<details class="topic"><summary>' +
        '<span class="dotc" style="background:' + esc(t.c) + '"></span>' +
        '<span>' + esc(t.n) + '</span>' +
        '<span class="tn">카드 ' + n + (ytxt ? ' (' + ytxt + ')' : '') + ' · 🔴' + bySev.critical + ' 🟡' + bySev.caution + ' 🟢' + bySev.tip + '</span>' +
        '</summary><div class="topicbody">' +
        '<p class="lead">' + esc(t.lead || '') + '</p>' +
        (t.points && t.points.length ? '<ul>' + t.points.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '') +
        (t.warn ? '<div class="warn2"><b>⚠️ 의견 갈림</b> — ' + esc(t.warn) + '</div>' : '') +
        '<div><button class="btn small" type="button" data-topic="' + esc(t.n) + '">이 주제 카드 ' + n + '장만 보기</button></div>' +
        '</div></details>';
    }).join('');
    box.innerHTML = '<details class="fold"><summary><h2>주제별 정리</h2>' +
      '<span class="n">' + (DATA.topics || []).length + '개 주제 · 주제를 고르면 카드가 그 주제만 남습니다</span></summary>' +
      '<div class="foldbody" style="padding-top:10px">' + items + '</div></details>';
  }

  /* ── 상태 표시 ───────────────────────────────────────── */
  function setState(text, kind) {
    var el = $('#stateTxt');
    if (!el) return;
    el.textContent = text;
    el.className = 'state' + (kind ? ' ' + kind : '');
    el.title = text;
    barState(null, kind);
  }

  function barState(count, kind) {
    var el = $('#barState');
    if (!el) return;
    var st = $('#stateTxt');
    var t = (st && st.textContent) || '';
    if (count != null) barState._n = count;
    t = t.replace(/불러옴 \d{4}-\d{2}-\d{2} /, '불러옴 ').replace(/\s*·\s*(내 JSON 파일|드라이브)$/, '');
    el.textContent = t ? '· ' + t : '';
    el.className = 'bstate' + (kind ? ' ' + kind : '');
  }

  /* ── 전체 렌더 ────────────────────────────────────────── */
  function renderAll() {
    renderYears();
    renderMonths();
    renderPlaybook();
    renderRows();
    renderDeck();
    syncTopbarHeight();
    var m = $$('#mstrip .mbtn').filter(function (b) { return b.dataset.m === S.month; })[0];
    if (m && m.scrollIntoView && m.parentNode && m.parentNode.scrollWidth > m.parentNode.clientWidth) {
      m.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }

  function setMonth(m, scroll) {
    S.month = m;
    S.topic = '';
    if (S.year !== 'all' && m !== 'all' && !yearAvail(S.year)) S.year = 'all';
    renderAll();
    if (scroll) {
      var top = $('#playbook').getBoundingClientRect().top + window.pageYOffset - barPad();
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  }

  function setYear(y) {
    S.year = String(y);
    lsSet(LS_YEAR, S.year);
    if (S.month !== 'all' && S.year !== 'all' && !yearAvail(S.year)) { S.year = 'all'; lsSet(LS_YEAR, ''); }
    renderAll();
    var top = $('#playbook').getBoundingClientRect().top + window.pageYOffset - barPad();
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  function jumpToCard(id) {
    var a = BYID[id]; if (!a) return;
    S.month = monOf(a); S.year = yrOf(a); S.sev = 'all'; S.role = 'all'; S.ms = false; S.topic = ''; S.q = '';
    var qi = $('#q'); if (qi) qi.value = '';
    renderAll();
    var el = $('#cards .card[data-id="' + id + '"]');
    if (!el) { toast('이 카드를 찾지 못했습니다', true); return; }
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    var top = el.getBoundingClientRect().top + window.pageYOffset - barPad() - 6;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  /* ── 동기화 ──────────────────────────────────────────── */
  function sync(opts) {
    opts = opts || {};
    if (!DATA) setState('데이터 없음');
    var url = bridgeUrl();
    if (!url) {
      if (!opts.silent) { toast('먼저 연결 주소를 넣어 주세요', true); openDlg(); }
      return Promise.resolve(false);
    }
    if (syncing) return Promise.resolve(false);
    syncing = true;
    if (!opts.silent) { setState('확인하는 중…'); $('#btnSync').disabled = true; }
    return bridgeInfo().then(function (info) {
      var up = (info && info.updated) || '', sz = String((info && info.size) || '');
      var same = DATA && lastMeta && lastMeta.driveUpdated && up &&
        lastMeta.driveUpdated === up && String(lastMeta.driveSize || '') === sz;
      if (same) {
        lsSet(LS_SYNC, String(Date.now()));
        setState('최신 상태 · ' + nowText(), 'ok');
        if (!opts.silent) toast('이미 최신 데이터입니다');
        refreshDlgInfo();
        return true;
      }
      if (!opts.silent) setState('내려받는 중… (두 해 자료)');
      return bridgeGet().then(function (r) {
        return saveArchive(r.payload, 'drive', { driveUpdated: r.updated, driveSize: r.size }).then(function () {
          lsSet(LS_SYNC, String(Date.now()));
          applyData(r.payload, { savedAt: Date.now(), source: 'drive', driveUpdated: r.updated, driveSize: r.size });
          if (!opts.silent) toast('데이터 ' + num(r.payload.articles.length) + '건을 받았습니다');
          refreshDlgInfo();
          return true;
        });
      });
    }).catch(function (err) {
      var msg = (err && err.message) || '연결 실패';
      setState(DATA ? '동기화 실패 · 저장된 데이터로 보는 중' : '연결 실패 · ' + msg, 'err');
      if (!opts.silent) toast(msg, true);
      refreshDlgInfo();
      return false;
    }).then(function (v) {
      syncing = false; $('#btnSync').disabled = false; return v;
    });
  }

  function autoSync() {
    if (!bridgeUrl()) return;
    var last = +(lsGet(LS_SYNC) || 0);
    if (!last || Date.now() - last > AUTO_MS) sync({ silent: true });
  }

  /* ── 설정 대화상자 ───────────────────────────────────── */
  function openDlg() {
    $('#fldUrl').value = bridgeUrl();
    $('#fldKey').value = bridgeKey();
    refreshDlgInfo();
    var d = $('#dlg');
    if (d && d.showModal) { try { d.showModal(); } catch (e) { d.setAttribute('open', ''); } }
    else if (d) d.setAttribute('open', '');
  }
  function closeDlg() {
    var d = $('#dlg');
    if (d && d.close) { try { d.close(); } catch (e) { /* noop */ } }
    else if (d) d.removeAttribute('open');
  }
  function refreshDlgInfo() {
    try {
      var lines = [];
      if (DATA) {
        var s = DATA.source || {};
        lines.push('지금 담긴 데이터 · ' + (DATA.title || '') + ' / 글 ' + num(s.articles) + '건 · 댓글 ' + num(s.comments) + '건');
        lines.push('양식 · schema ' + (DATA.schema || 1) + ' · 카드 ' + num(CARDS.length) + '장 · 월별 플레이북 ' + Object.keys(DATA.monthlyPlaybooks || {}).length + '개');
        if (s.by_year) {
          lines.push('연도 · ' + YEARS.map(function (y) {
            var b = s.by_year[y] || {};
            return y + ' 글 ' + num(b.articles) + '건/카드 ' + num(b.cards) + '장';
          }).join(' · '));
        }
        lines.push('데이터 기준 · ' + (DATA.built_at || '-') + (lastMeta && lastMeta.source === 'file' ? ' (내 JSON 파일)' : ' (드라이브)'));
      } else {
        lines.push('아직 담긴 데이터가 없습니다.');
      }
      var last = +(lsGet(LS_SYNC) || 0);
      lines.push('마지막 동기화 · ' + (last ? nowText(last) : '없음'));
      lines.push('연결 주소 · ' + (bridgeUrl() ? '설정됨' : '없음'));
      $('#dlgInfo').textContent = lines.join('\n');
      $('#dlgWhere').textContent = '저장 위치 · 이 브라우저(IndexedDB)';
    } catch (e) { /* noop */ }
  }

  /* ── 로컬 파일 ───────────────────────────────────────── */
  function loadFile(file) {
    if (!file) return;
    if (file.size > MAX_KB * 1024) { toast('파일이 너무 큽니다', true); return; }
    var r = new FileReader();
    r.onload = function () {
      var payload;
      try { payload = JSON.parse(String(r.result)); } catch (e) { toast('JSON을 읽지 못했습니다', true); return; }
      if (!payload || !Array.isArray(payload.articles)) { toast('아카이브 JSON이 아닙니다', true); return; }
      saveArchive(payload, 'file').then(function () {
        applyData(payload, { savedAt: Date.now(), source: 'file' });
        closeDlg();
        toast('내 JSON 파일을 불러왔습니다');
      });
    };
    r.onerror = function () { toast('파일을 읽지 못했습니다', true); };
    r.readAsText(file, 'utf-8');
  }

  /* ── 이벤트 ──────────────────────────────────────────── */
  function bind() {
    $('#btnSync').addEventListener('click', function () { sync({}); });
    $('#btnSet').addEventListener('click', openDlg);
    $('#btnSetupConnect').addEventListener('click', openDlg);
    $('#btnSetupFile').addEventListener('click', function () { $('#fileIn').click(); });
    $('#dlgFile').addEventListener('click', function () { $('#fileIn').click(); });
    $('#fileIn').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      loadFile(f);
    });
    $('#brandLink').addEventListener('click', function (e) {
      e.preventDefault();
      setMonth('all', true);
    });

    $('#dlgClose').addEventListener('click', closeDlg);
    $('#dlgSave').addEventListener('click', function () {
      var u = $('#fldUrl').value.trim();
      if (u && !/^https:\/\/.+/i.test(u)) { toast('https:// 로 시작하는 주소를 넣어 주세요', true); return; }
      lsSet(LS_URL, u);
      lsSet(LS_KEY, $('#fldKey').value.trim());
      if (!u) { toast('연결 주소를 지웠습니다'); refreshDlgInfo(); return; }
      sync({}).then(function (ok) { if (ok) closeDlg(); });
    });
    $('#dlgTest').addEventListener('click', function () {
      var u = $('#fldUrl').value.trim();
      if (!u) { toast('연결 주소를 먼저 넣어 주세요', true); return; }
      var prevU = bridgeUrl(), prevK = bridgeKey();
      lsSet(LS_URL, u); lsSet(LS_KEY, $('#fldKey').value.trim());
      toast('연결을 확인하는 중…');
      bridgeInfo().then(function (p) {
        toast('연결 성공 · ' + num(Math.round((p.size || 0) / 1024)) + 'KB · ' + String(p.updated || '').slice(0, 10));
      }).catch(function (e) {
        lsSet(LS_URL, prevU); lsSet(LS_KEY, prevK);
        toast('연결 실패 · ' + ((e && e.message) || ''), true);
      });
    });
    $('#dlgWipe').addEventListener('click', function () {
      if (!window.confirm('이 기기에 담긴 데이터를 지울까요? (드라이브 원본은 그대로)')) return;
      memRec = null;
      (idbBroken ? Promise.resolve() : idbDel(REC).catch(function () { })).then(function () {
        DATA = null; BYID = Object.create(null); HAY = new Map(); CARDS = [];
        $('#content').hidden = true;
        $('#setupPanel').hidden = false;
        $('#mstrip').innerHTML = '';
        var ys = $('#yrseg'); if (ys) ys.innerHTML = '';
        setState('데이터 없음');
        refreshDlgInfo();
        toast('이 기기의 데이터를 지웠습니다');
      });
    });

    // 월·연도 선택 · 필터 · 카드 이동
    document.addEventListener('click', function (e) {
      var yb = e.target.closest('#yrseg .yrbtn');
      if (yb && !yb.disabled) { setYear(yb.dataset.y); return; }
      var mb = e.target.closest('[data-m]');
      if (mb && !e.target.closest('.row')) { setMonth(mb.dataset.m, true); return; }
      var jp = e.target.closest('[data-jump]');
      if (jp) { jumpToCard(+jp.dataset.jump); return; }
      var ch = e.target.closest('#chips .chip');
      if (ch) {
        if (ch.dataset.sev) S.sev = ch.dataset.sev;
        if (ch.dataset.role) S.role = S.role === ch.dataset.role ? 'all' : ch.dataset.role;
        if (ch.dataset.ms) S.ms = !S.ms;
        if (ch.dataset.topicclear) S.topic = '';
        renderDeck();
        return;
      }
      var tb = e.target.closest('[data-topic]');
      if (tb) {
        S.topic = tb.dataset.topic; S.month = 'all';
        renderAll();
        var top = $('#deckbar').getBoundingClientRect().top + window.pageYOffset - barPad();
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        return;
      }
      var fold = e.target.closest('#btnPbFold');
      if (fold) {
        lsSet(LS_PBFOLD, pbFolded() ? '' : '1');
        renderPlaybook();
        syncTopbarHeight();
        return;
      }
      var go = e.target.closest('[data-go]');
      if (go) {
        var target = go.dataset.go === 'mines' ? $('#mines')
          : go.dataset.go === 'cards' ? $('#cards') : $('#playbook');
        if (!target) return;
        if (go.dataset.go !== 'playbook' && pbFolded()) { lsSet(LS_PBFOLD, ''); renderPlaybook(); syncTopbarHeight(); }
        var t2 = target.getBoundingClientRect().top + window.pageYOffset - barPad() - 4;
        window.scrollTo({ top: Math.max(0, t2), behavior: 'smooth' });
        return;
      }
      if (e.target.closest('#btnMoreHit')) {
        searchLimit += 40; renderSearch(S.q.trim().toLowerCase());
      }
    });

    // 검색
    var qt = null;
    $('#q').addEventListener('input', function () {
      var v = this.value;
      clearTimeout(qt);
      qt = setTimeout(function () { S.q = v; searchLimit = 40; renderDeck(); }, 170);
    });
    $('#btnClearQ').addEventListener('click', function () {
      S.q = ''; $('#q').value = ''; renderDeck(); $('#q').focus();
    });
    $('#sortSel').addEventListener('change', function () { S.sort = this.value; renderDeck(); });
    $('#btnTop').addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

    // 원문 글 펼칠 때 내용 채우기
    document.addEventListener('toggle', function (e) {
      var d = e.target;
      if (!d.classList) return;
      if (d.classList.contains('row')) {
        if (d.open && !d.dataset.loaded) {
          var a = BYID[+d.dataset.id];
          if (a) { d.insertAdjacentHTML('beforeend', detailHtml(a)); d.dataset.loaded = '1'; }
        }
      } else if (d.classList.contains('src')) {
        if (d.open && !d.dataset.loaded) {
          var card = d.closest('.card');
          var ac = card ? BYID[+card.dataset.id] : null;
          if (ac) { d.insertAdjacentHTML('beforeend', cardSrcHtml(ac)); d.dataset.loaded = '1'; }
        }
      }
    }, true);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') autoSync();
    });
    window.addEventListener('online', function () { autoSync(); });
    window.addEventListener('resize', function () { syncTopbarHeight(); });
    if (typeof ResizeObserver !== 'undefined') {
      try {
        var ro = new ResizeObserver(syncTopbarHeight);
        ['.topbar', '#mstrip', '#deckbar'].forEach(function (s) { var el = $(s); if (el) ro.observe(el); });
      } catch (e) { /* noop */ }
    }
  }

  /* ── 시작 ────────────────────────────────────────────── */
  function boot() {
    bind();
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        /* 주소의 ?v= 를 바꾸면 새 워커로 갈아탄다(HTTP 캐시에 옛 sw.js 가 남아도 확실히).
           릴리스할 때마다 sw.js 의 VERSION 과 이 값을 함께 올린다. */
        navigator.serviceWorker.register('sw.js?v=9').catch(function () { });
      });
    }
    var cached = memRec;
    var p = idbBroken ? Promise.resolve(null) : idbGet(REC).catch(function () { idbBroken = true; return null; });
    Promise.resolve(p).then(function (rec) {
      rec = rec || cached;
      if (rec && rec.json) {
        try { applyData(JSON.parse(rec.json), rec); } catch (e) { /* 손상된 캐시는 무시 */ }
      }
      if (!DATA) {
        $('#setupPanel').hidden = false;
        $('#content').hidden = true;
        setState(bridgeUrl() ? '연결됨 · 아직 받은 데이터 없음' : '데이터 없음');
      }
      autoSync();
      refreshDlgInfo();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
