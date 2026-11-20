/* Y공작소 아카이브 · 껍데기 PWA
 * ────────────────────────────────────────────────────────────
 * 이 파일에는 게시글·댓글 등 실제 데이터가 한 줄도 없다.
 * 데이터는 ① 내 비공개 구글 드라이브(Apps Script 연결 주소) 또는
 *            ② 사용자가 고른 로컬 JSON 파일로만 들어오고,
 *            IndexedDB(이 기기)에만 담긴다.
 */
(function () {
  'use strict';

  var LS_URL = 'na.bridge', LS_KEY = 'na.key', LS_SYNC = 'na.lastSyncMeta';
  var DB_NAME = 'neis-archive', STORE = 'kv', REC = 'archive';
  var AUTO_MS = 30 * 60 * 1000;           // 30분 지나면 조용히 새로 받기
  var MAX_KB = 60 * 1024;                 // 받는 파일 상한(60MB) — 오작동 방지

  var DATA = null, MONTHS = [], BYID = Object.create(null), HAY = new Map();
  var S = { from: 1, to: 10, q: '', ms: false };
  var lastMeta = null, syncTimer = null;

  window.__naErrors = [];
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
  function tid(id) { return String(id).replace(/[^0-9]/g, ''); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function nowText(ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function toast(msg, isErr) {
    var t = $('#toast');
    t.textContent = msg; t.hidden = false;
    t.className = 'toast' + (isErr ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, isErr ? 5200 : 3000);
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
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 60000);
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

  /** 파일 정보만 받아 온다(작은 응답) — 이미 받은 것과 같으면 3MB를 다시 받지 않는다 */
  function bridgeInfo() { return callBridge({ action: 'info' }, 30000); }

  /** 실제 데이터 받기 */
  function bridgeGet() {
    return callBridge({ action: 'get' }, 120000).then(function (body) {
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
    var json = JSON.stringify(payload);
    var rec = { json: json, savedAt: Date.now(), source: source, built: payload.built_at || '', bytes: json.length };
    if (extra) { rec.driveUpdated = extra.driveUpdated || ''; rec.driveSize = String(extra.driveSize || ''); }
    memRec = rec;
    if (!idbBroken) {
      return idbSet(REC, rec).catch(function () { idbBroken = true; });
    }
    return Promise.resolve();
  }

  /* ── 데이터 적용 ──────────────────────────────────────── */
  function applyData(payload, meta) {
    if (!payload || !payload.articles) return;
    var first = !DATA;
    DATA = payload;
    MONTHS = payload.months && payload.months.length ? payload.months : ['2026-01'];
    if (first) { S.from = 1; S.to = MONTHS.length; }
    BYID = Object.create(null); HAY = new Map();
    payload.articles.forEach(function (a) { BYID[a.i] = a; });
    lastMeta = meta || null;

    renderHero();
    renderSummary();
    renderToolbarMonths();
    renderTopics();
    renderHighlight();
    $('#setupPanel').hidden = true;
    $('#content').hidden = false;
    applyFilter();
    setState((meta && meta.savedAt ? '불러옴 ' + nowText(meta.savedAt) + ' · ' : '') +
      (meta && meta.source === 'file' ? '내 JSON 파일' : '드라이브'), 'ok');
    window.__naState = {
      articles: payload.articles.length, cards: $$('#topics .card').length,
      topics: $$('#topics .topic').length, built: payload.built_at,
      visible: $$('#topics .card:not(.hide)').length
    };
  }

  function renderHero() {
    var s = DATA.source || {};
    $('#appTitle').textContent = DATA.title || 'Y공작소 이슈 아카이브';
    $('#heroSub').textContent = (s.months || '') + ' · 본문 ' + num(s.articles) + '건과 댓글 ' + num(s.comments) +
      '건을 주제별로 정리했습니다.';
    var chips = $('#chips');
    chips.innerHTML =
      '<span>본문 <b>' + num(s.articles) + '</b>건</span>' +
      '<span>댓글 <b>' + num(s.comments) + '</b>건</span>' +
      '<span>주제 <b>' + num(s.topics) + '</b></span>' +
      '<span>맑은샘 답변 <b>' + num(s.ms_articles) + '</b>글 / <b>' + num(s.ms_comments) + '</b>댓글</span>' +
      '<span>데이터 기준 <b>' + esc(DATA.built_at || '') + '</b></span>';
    chips.hidden = false;
  }

  function renderSummary() {
    var s = DATA.source || {};
    var st = [
      ['전체 메타데이터', num(s.meta_total), '(1~10월 수집 모집단)'],
      ['정밀 수집 글', num(s.articles), '본문·댓글 직접 수집'],
      ['댓글', num(s.comments), '원문 그대로'],
      ['대표 질문 카드', num(s.cards), '정리 + 근거 댓글'],
      ['맑은샘 답변 글', num(s.ms_articles), '댓글 ' + num(s.ms_comments) + '개'],
      ['주제', num(s.topics), '주제별 넘기기']
    ];
    $('#stats').innerHTML = st.map(function (x) {
      return '<div class="stat"><b>' + x[1] + '</b><span>' + esc(x[0]) + '</span><em style="font-size:10.5px">' + esc(x[2]) + '</em></div>';
    }).join('');

    var mc = DATA.month_comments || {}, mx = 1;
    MONTHS.forEach(function (m) { mx = Math.max(mx, mc[m] || 0); });
    $('#mbars').innerHTML = MONTHS.map(function (m) {
      var v = mc[m] || 0, h = Math.max(4, Math.round(v / mx * 70));
      return '<div data-m="' + m + '" title="' + m.slice(5) + '월 댓글 ' + num(v) + '"><i style="height:' + h + 'px"></i><b>' + (+m.slice(5)) + '월</b></div>';
    }).join('');

    var tp = (DATA.topics || []).slice().sort(function (a, b) { return b.st.c - a.st.c; });
    var mxc = Math.max.apply(null, tp.map(function (t) { return t.st.c; }).concat([1]));
    $('#rank').innerHTML = tp.map(function (t) {
      return '<div class="rk"><span class="nm" data-topic="' + esc(t.n) + '">' + esc(t.n) + '</span>' +
        '<span class="bar"><i style="width:' + Math.round(t.st.c / mxc * 100) + '%;background:' + esc(t.c) + '"></i></span>' +
        '<span class="vl">글 ' + t.st.n + ' · 댓글 ' + num(t.st.c) + '</span></div>';
    }).join('');

    $('#noteBox').innerHTML = '<b>수집 범위 안내</b> · 전체 ' + num(s.meta_total) + '건 중 <b>' + num(s.articles) +
      '건</b>은 월별·게시판 균형을 맞춰 댓글·좋아요가 많은 글을 골라 본문과 댓글을 직접 수집한 것입니다. ' +
      '대표 질문 카드는 그중 근거가 분명한 글을 골라 정리한 것이고, 확인되지 않은 사안은 단정하지 않고 <b>⚠ 의견 갈림</b>으로 표시했습니다. ' +
      '이 앱은 GitHub Pages의 껍데기이고, 실제 데이터는 내 비공개 드라이브에서만 받아 옵니다.';
    $('#sumHint').textContent = '기간 ' + rangeLabel();
  }

  function renderToolbarMonths() {
    var cnt = DATA.month_counts || {};
    $('#mtabs').innerHTML = MONTHS.map(function (m) {
      return '<button class="mtab" type="button" data-m="' + m + '">' + (+m.slice(5)) + '월<b>' + (cnt[m] || 0) + '</b></button>';
    }).join('');
    $('#mFrom').innerHTML = MONTHS.map(function (m, i) {
      return '<option value="' + (i + 1) + '">' + (+m.slice(5)) + '월</option>';
    }).join('');
    $('#mTo').innerHTML = MONTHS.map(function (m, i) {
      return '<option value="' + (i + 1) + '"' + (i === MONTHS.length - 1 ? ' selected' : '') + '>' + (+m.slice(5)) + '월</option>';
    }).join('');
    $('#mFrom').value = S.from; $('#mTo').value = S.to;
    markMonth();
  }

  function renderTopics() {
    var html = (DATA.topics || []).map(function (t) {
      var rows = DATA.articles.filter(function (a) { return a.p === t.n; })
        .sort(function (a, b) { return (b.n - a.n) || (b.l - a.l) || (b.i - a.i); });
      var faq = (t.faq || []).map(function (id) { return BYID[id]; }).filter(Boolean);
      var mxm = Math.max.apply(null, MONTHS.map(function (m) { return t.st.months[m] || 0; }).concat([1]));
      var spark = MONTHS.map(function (m) {
        return '<i style="height:' + Math.max(2, Math.round((t.st.months[m] || 0) / mxm * 16)) + 'px"></i>';
      }).join('');
      return '<section class="topic" data-topic="' + esc(t.n) + '" id="tp' + hashName(t.n) + '">' +
        '<div class="thead" role="button" tabindex="0" aria-expanded="true">' +
        '<span class="dot" style="background:' + esc(t.c) + '"></span>' +
        '<h2>' + esc(t.n) + '</h2>' +
        '<span class="tmeta"><span class="bdg">글 <b>' + t.st.n + '</b></span>' +
        '<span class="bdg cmt">댓글 <b>' + num(t.st.c) + '</b></span>' +
        '<span class="bdg ms">맑은샘 <b>' + t.st.ms + '</b></span>' +
        '<span class="bdg like">♥ ' + t.st.like + '</span></span>' +
        '<span class="sp"></span>' +
        '<span class="mspark" aria-hidden="true" style="display:inline-flex;gap:2px;align-items:flex-end;height:18px">' + spark + '</span>' +
        '<button class="toggle" type="button" aria-label="접기/펼치기">접기</button></div>' +
        '<div class="tbody">' +
        '<p class="lead">' + esc(t.lead || '') + '</p>' +
        (t.points && t.points.length ? '<ul class="points">' + t.points.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '') +
        (t.warn ? '<div class="warn"><b>⚠️ 의견 갈림 · 추가 확인 필요</b> — ' + esc(t.warn) + '</div>' : '') +
        '<div class="lhead" data-role="faqhead"><h4>대표 질문과 답변</h4><span class="n" data-role="fcount">' + faq.length + '건 · 댓글 원문 인용</span></div>' +
        '<div class="faqs" data-role="faqs">' + faq.map(cardHtml).join('') + '</div>' +
        '<div class="lhead"><h4>원문 글 전체</h4><span class="n" data-role="tcount">' + rows.length + '건</span>' +
        '<select class="sortsel" aria-label="정렬"><option value="cmt">댓글 많은 순</option><option value="new">최신순</option><option value="like">좋아요 순</option></select></div>' +
        '<div class="rows" data-role="rows">' + rows.map(rowHtml).join('') + '</div>' +
        '<div class="empty" data-role="empty" hidden>이 범위에 해당하는 글이 없습니다.</div>' +
        '</div></section>';
    }).join('');
    $('#topics').innerHTML = html;
    $('#ftr').innerHTML = 'Y공작소 아카이브 · 본문 ' + num(DATA.articles.length) + '건 / 댓글 ' +
      num(DATA.articles.reduce(function (s, a) { return s + a.n; }, 0)) + '건 · 데이터는 내 구글 드라이브에만 있습니다.';
  }

  function hashName(s) {
    var h = 0; for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return Math.abs(h).toString(36);
  }

  function cardHtml(a) {
    if (!a) return '';
    var isData = /업무자료공유|연수물자료공유|업무관련 매뉴얼|생활기록부 훈령/.test(a.b);
    var badges = '';
    if (a.s) badges += '<span class="tg ms">맑은샘 답변글</span>';
    (a.g || []).forEach(function (t) { badges += '<span class="tg">' + esc(t) + '</span>'; });
    var body = String(a.bd || '').replace(/\s+/g, ' ').trim();
    var cut = isData ? 420 : 320;
    if (body.length > cut) body = body.slice(0, cut) + ' …';
    var ans = '';
    if (a.x) ans += '<p class="anote">' + esc(a.x.length > 520 ? a.x.slice(0, 520) + ' …' : a.x) + '</p>';
    if (a.bc && (a.bc.ms || !isData)) {
      ans += '<div class="aquote' + (a.bc.ms ? '' : ' gen') + '"><span class="who">원문 댓글 · ' +
        esc(a.bc.n) + ' (' + esc(a.bc.d) + ')</span>' + esc(a.bc.c) + '</div>';
    }
    var ah = '';
    if (ans) ah = (isData && !a.x) ? '<span class="ah gen">공유 자료 · 본문 참고</span>' :
      (a.x ? '<span class="ah">정리 + 근거 댓글</span>' : '<span class="ah gen">원문 댓글</span>');
    else {
      ans = body.length > 180
        ? '<p class="anote">본문에 정리된 내용을 그대로 참고하세요. 아래 원문에서 댓글 반응까지 확인할 수 있습니다.</p>'
        : '<p class="anote">댓글에서 확정된 답을 찾지 못했습니다. 원문 댓글을 직접 확인하세요.</p>';
      ah = '<span class="ah gen">본문 참고</span>';
    }
    return '<article class="card" data-id="' + a.i + '">' +
      '<div class="q"><div class="qtop"><span class="qid">' + a.i + '</span>' +
      '<span class="qdate">' + esc(String(a.d).slice(0, 10)) + ' · ' + esc(a.b) + '</span>' +
      '<span class="bdg cmt">댓글 ' + a.n + '</span>' + (a.l ? '<span class="bdg like">♥ ' + a.l + '</span>' : '') + '</div>' +
      '<h5 class="qtitle"><a href="' + esc(a.u) + '" target="_blank" rel="noopener">' + esc(a.t) + '</a></h5>' +
      '<p class="qbody">' + esc(body) + '</p></div>' +
      '<div class="a">' + ah + ans +
      '<div class="foot"><a class="lnk" href="' + esc(a.u) + '" target="_blank" rel="noopener">카페 원문 열기 →</a>' +
      '<span class="tags">' + badges + '</span></div></div></article>';
  }

  function rowHtml(a) {
    var note = a.x ? '<div class="nt">' + esc(a.x.length > 190 ? a.x.slice(0, 190) + ' …' : a.x) + '</div>' : '';
    return '<details class="row" data-id="' + a.i + '" data-m="' + esc(a.m) + '" data-s="' + (a.s ? 1 : 0) +
      '" data-cmt="' + (a.n || 0) + '" data-like="' + (a.l || 0) + '" data-d="' + esc(a.d) + '">' +
      '<summary><span class="dt">' + esc(String(a.d).slice(5, 10).replace('-', '.')) + '</span>' +
      '<span class="bd">' + esc(a.b) + '</span>' +
      '<span class="tx"><span class="ti">' + esc(a.t) + '</span>' + note + '</span>' +
      '<span class="mt">' + (a.s ? '<span class="ms">맑은샘</span>' : '') + (a.pa ? '<span class="pt" title="첫 10개 댓글만 보관">일부</span>' : '') +
      '<span>💬' + (a.n || 0) + '</span>' + (a.l ? '<span>♥' + a.l + '</span>' : '') + '</span></summary></details>';
  }

  function detailHtml(a) {
    var h = '<div class="detail">';
    if (a.x) h += '<p class="anote">' + esc(a.x) + '</p>';
    if (a.bd) h += '<p class="bdtext">' + esc(a.bd) + '</p>';
    if (a.pa) h += '<p class="mini-note">※ 이 글은 첫 10개 댓글만 보관되어 있습니다.</p>';
    if (a.cm && a.cm.length) {
      h += a.cm.map(function (c) {
        return '<div class="cm' + (c.n === '맑은샘' ? ' best' : '') + '">' +
          '<span class="who">' + esc(c.n) + '</span><span class="cdate">' + esc(c.d) + '</span>' +
          (c.r ? '<span class="rp">답글</span>' : '') + '<div>' + esc(c.c) + '</div></div>';
      }).join('');
    } else {
      h += '<p class="mini-note">보관된 댓글이 없습니다.</p>';
    }
    h += '<a class="dlink" href="' + esc(a.u) + '" target="_blank" rel="noopener">카페 원문 열기 →</a></div>';
    return h;
  }

  function renderHighlight() {
    var ms = DATA.articles.filter(function (a) { return a.s; })
      .sort(function (a, b) { return (b.n - a.n) || (b.l - a.l); }).slice(0, 14);
    $('#hlist').innerHTML = ms.map(function (a) {
      var t = a.x || (a.bc && a.bc.c) || '';
      if (t.length > 150) t = t.slice(0, 150) + ' …';
      return '<li class="hl" data-id="' + a.i + '"><a data-open="' + a.i + '">' +
        '<span class="hlq">' + esc(a.t) + '</span>' +
        '<span class="hlm">' + esc(String(a.d).slice(0, 10)) + ' · ' + esc(a.b) + ' · 댓글 ' + a.n + '</span>' +
        '<span class="hla">' + esc(t) + '</span></a></li>';
    }).join('');
    $('#hlHint').textContent = '답변이 달린 글 ' + num(DATA.source.ms_articles) + '건 중 댓글 많은 ' + ms.length + '건';
  }

  /* ── 필터 ────────────────────────────────────────────── */
  function monthIdx(m) { var i = MONTHS.indexOf(m); return i < 0 ? 0 : i + 1; }
  function inRange(a) { var i = monthIdx(a.m); return i >= S.from && i <= S.to; }
  function hay(a) {
    var v = HAY.get(a.i);
    if (v) return v;
    v = (a.t + ' ' + (a.bd || '') + ' ' + (a.x || '') + ' ' + (a.b || '') + ' ' + (a.p || '') + ' ' +
      (a.cm || []).map(function (c) { return c.c; }).join(' ')).toLowerCase();
    HAY.set(a.i, v); return v;
  }
  function matches(a, q) {
    if (!inRange(a)) return false;
    if (S.ms && !a.s) return false;
    if (!q) return true;
    return hay(a).indexOf(q) >= 0;
  }
  function rangeLabel() { return S.from === S.to ? S.from + '월' : S.from + '~' + S.to + '월'; }

  function applyFilter() {
    if (!DATA) return;
    var q = S.q.trim().toLowerCase();
    var vis = Object.create(null), cmSum = 0, cnt = 0;
    DATA.articles.forEach(function (a) {
      if (matches(a, q)) { vis[a.i] = 1; cnt++; cmSum += a.n || 0; }
    });
    $$('#topics section.topic').forEach(function (sec) {
      var vc = 0, vr = 0;
      $$('.card', sec).forEach(function (el) {
        var ok = !!vis[+el.dataset.id];
        el.classList.toggle('hide', !ok); if (ok) vc++;
      });
      $$('.row', sec).forEach(function (el) {
        var ok = !!vis[+el.dataset.id];
        el.classList.toggle('hide', !ok); if (ok) vr += BYID[+el.dataset.id].n || 0;
      });
      var fc = $('[data-role=fcount]', sec);
      if (fc) fc.textContent = vc + '건 · 댓글 원문 인용';
      var fh = $('[data-role=faqhead]', sec), fb = $('[data-role=faqs]', sec);
      if (fh) fh.style.display = vc ? '' : 'none';
      if (fb) fb.style.display = vc ? '' : 'none';
      var tc = $('[data-role=tcount]', sec);
      if (tc) tc.textContent = vr ? num(vr) + '건' : '0건';
      var em = $('[data-role=empty]', sec);
      if (em) em.hidden = vr > 0;
    });
    $$('#hlist .hl').forEach(function (el) { el.classList.toggle('hide', !vis[+el.dataset.id]); });
    $('#rng').innerHTML = '선택 기간 <b>' + rangeLabel() + '</b> · 글 <b>' + num(cnt) + '</b>건 · 댓글 <b>' + num(cmSum) + '</b>건';
    $('#sumHint').textContent = '기간 ' + rangeLabel();
    markMonth();
    markPreset();
  }

  function markMonth() {
    $$('#mtabs .mtab').forEach(function (b) {
      var i = MONTHS.indexOf(b.dataset.m) + 1;
      b.classList.toggle('on', S.from === i && S.to === i);
    });
    var f = $('#mFrom'), t = $('#mTo');
    if (f) f.value = S.from;
    if (t) t.value = S.to;
  }
  function markPreset() {
    $$('#presets .pill').forEach(function (p) {
      var r = p.dataset.preset.split('-').map(Number);
      p.classList.toggle('on', r[0] === S.from && r[1] === S.to);
    });
  }
  function setRange(f, t, opts) {
    f = Math.max(1, Math.min(MONTHS.length, f));
    t = Math.max(1, Math.min(MONTHS.length, t));
    if (f > t) { var x = f; f = t; t = x; }
    S.from = f; S.to = t;
    applyFilter();
    if (opts && opts.scrollTop) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ── 상태 표시 ───────────────────────────────────────── */
  function setState(text, kind) {
    var el = $('#stateTxt');
    el.textContent = text;
    el.className = 'state' + (kind ? ' ' + kind : '');
    el.title = text;
  }

  /* ── 동기화 ──────────────────────────────────────────── */
  var syncing = false;
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
      if (!opts.silent) setState('내려받는 중…');
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
    var lines = [];
    if (DATA) {
      lines.push('지금 담긴 데이터 · ' + (DATA.title || '') + ' / 글 ' + num(DATA.source.articles) + '건 · 댓글 ' + num(DATA.source.comments) + '건');
      lines.push('받은 시각 · ' + (DATA.built_at || '-') + (lastMeta && lastMeta.source === 'file' ? ' (내 JSON 파일)' : ' (드라이브)'));
    } else {
      lines.push('아직 담긴 데이터가 없습니다.');
    }
    var last = +(lsGet(LS_SYNC) || 0);
    lines.push('마지막 동기화 · ' + (last ? nowText(last) : '없음'));
    lines.push('연결 주소 · ' + (bridgeUrl() ? '설정됨' : '없음'));
    if (typeof navigator !== 'undefined' && 'storage' in navigator && navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (e) {
        var kb = Math.round((e.usage || 0) / 1024);
        var el = $('#dlgWhere');
        if (el) el.textContent = '저장 위치 이 기기 · ' + kb.toLocaleString('ko-KR') + 'KB 사용';
      }).catch(function () {});
    }
    $('#dlgInfo').textContent = lines.join('\n');
    $('#dlgWhere').textContent = '저장 위치 · 이 브라우저(IndexedDB)';
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
        DATA = null; BYID = Object.create(null); HAY = new Map();
        $('#content').hidden = true;
        $('#setupPanel').hidden = false;
        $('#chips').hidden = true;
        $('#topics').innerHTML = '';
        setState('데이터 없음');
        refreshDlgInfo();
        toast('이 기기의 데이터를 지웠습니다');
      });
    });

    // 월 탭
    $('#mtabs').addEventListener('click', function (e) {
      var b = e.target.closest('.mtab'); if (!b) return;
      var i = MONTHS.indexOf(b.dataset.m) + 1;
      if (S.from === i && S.to === i) setRange(1, MONTHS.length);
      else setRange(i, i);
    });
    $('#presets').addEventListener('click', function (e) {
      var p = e.target.closest('.pill'); if (!p) return;
      var r = p.dataset.preset.split('-').map(Number);
      setRange(r[0], r[1]);
    });
    $('#mFrom').addEventListener('change', function () { setRange(+this.value, S.to); });
    $('#mTo').addEventListener('change', function () { setRange(S.from, +this.value); });

    // 검색
    var qt = null;
    $('#q').addEventListener('input', function () {
      var v = this.value;
      clearTimeout(qt);
      qt = setTimeout(function () { S.q = v; applyFilter(); }, 170);
    });
    $('#msOnly').addEventListener('click', function () {
      S.ms = !S.ms; this.classList.toggle('on', S.ms); applyFilter();
    });
    $('#btnClear').addEventListener('click', function () {
      S.q = ''; S.ms = false; $('#q').value = ''; $('#msOnly').classList.remove('on');
      setRange(1, MONTHS.length); toast('조건을 초기화했습니다');
    });
    $('#btnTop10').addEventListener('click', function () { setRange(1, MONTHS.length, { scrollTop: true }); });

    // 요약 접기
    $('#btnSumFold').addEventListener('click', function () {
      var s = $('#summary');
      s.classList.toggle('folded');
      this.textContent = s.classList.contains('folded') ? '요약 펼치기' : '요약 접기';
    });
    $('#btnHL').addEventListener('click', function () {
      var l = $('#hlist');
      l.classList.toggle('hide');
      this.textContent = l.classList.contains('hide') ? '펼치기' : '접기';
    });
    $('#btnAllClose').addEventListener('click', function () { setAllTopics(false); });
    $('#btnAllOpen').addEventListener('click', function () { setAllTopics(true); });

    // 주제 접기
    $('#topics').addEventListener('click', function (e) {
      var head = e.target.closest('.thead');
      if (head) {
        var sec = head.closest('.topic');
        var body = $('.tbody', sec);
        var hide = !body.classList.contains('hide');
        body.classList.toggle('hide', hide);
        head.setAttribute('aria-expanded', hide ? 'false' : 'true');
        var tg = $('.toggle', head);
        if (tg) tg.textContent = hide ? '펼치기' : '접기';
        return;
      }
      var nm = e.target.closest('.nm[data-topic]');
      if (nm) {
        var sec2 = $$('#topics .topic').filter(function (s) { return s.dataset.topic === nm.dataset.topic; })[0];
        if (sec2) {
          $('.tbody', sec2).classList.remove('hide');
          sec2.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    });
    $('#topics').addEventListener('keydown', function (e) {
      var head = e.target.closest && e.target.closest('.thead');
      if (head && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); head.click(); }
    });

    // 정렬
    $('#topics').addEventListener('change', function (e) {
      var sel = e.target.closest('.sortsel'); if (!sel) return;
      var sec = sel.closest('.topic');
      var box = $('[data-role=rows]', sec);
      var rows = $$('.row', box);
      var mode = sel.value;
      rows.sort(function (a, b) {
        if (mode === 'new') return a.dataset.d < b.dataset.d ? 1 : a.dataset.d > b.dataset.d ? -1 : 0;
        if (mode === 'like') return (+b.dataset.like) - (+a.dataset.like) || (+b.dataset.cmt) - (+a.dataset.cmt);
        return (+b.dataset.cmt) - (+a.dataset.cmt);
      });
      rows.forEach(function (r) { box.appendChild(r); });
    });

    // 상세 펼칠 때 내용 채우기
    $('#topics').addEventListener('toggle', function (e) {
      var d = e.target;
      if (!d.classList || !d.classList.contains('row')) return;
      if (d.open && !d.dataset.loaded) {
        var a = BYID[+d.dataset.id];
        if (a) { d.insertAdjacentHTML('beforeend', detailHtml(a)); d.dataset.loaded = '1'; }
      }
    }, true);

    // 하이라이트 → 그 글 펼치기
    $('#hlist').addEventListener('click', function (e) {
      var a = e.target.closest('[data-open]'); if (!a) return;
      e.preventDefault();
      openArticle(+a.dataset.open);
    });

    // 월별 막대 → 그 달
    $('#mbars').addEventListener('click', function (e) {
      var d = e.target.closest('[data-m]'); if (!d) return;
      var i = MONTHS.indexOf(d.dataset.m) + 1;
      setRange(i, i);
      $('#toolbar').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // 주제 순위(요약) → 그 주제로
    $('#rank').addEventListener('click', function (e) {
      var nm = e.target.closest('.nm[data-topic]'); if (!nm) return;
      var sec = $$('#topics .topic').filter(function (s) { return s.dataset.topic === nm.dataset.topic; })[0];
      if (sec) {
        $('.tbody', sec).classList.remove('hide');
        sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    $('#btnTop').addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

    // 돌아오면 조용히 새로 받기
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') autoSync();
    });
    window.addEventListener('online', function () { autoSync(); });
  }

  function setAllTopics(open) {
    $$('#topics .topic').forEach(function (sec) {
      $('.tbody', sec).classList.toggle('hide', !open);
      var head = $('.thead', sec);
      if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
      var tg = $('.toggle', head);
      if (tg) tg.textContent = open ? '접기' : '펼치기';
    });
  }

  function openArticle(id) {
    if (S.ms || S.q) { S.ms = false; S.q = ''; $('#q').value = ''; $('#msOnly').classList.remove('on'); }
    if (!inRange(BYID[id])) setRange(monthIdx(BYID[id].m), monthIdx(BYID[id].m));
    applyFilter();
    var row = $$('.row').filter(function (r) { return +r.dataset.id === id; })[0];
    if (!row) { toast('이 글은 담긴 데이터에 없습니다', true); return; }
    var sec = row.closest('.topic');
    $('.tbody', sec).classList.remove('hide');
    row.open = true;
    if (!row.dataset.loaded) { row.insertAdjacentHTML('beforeend', detailHtml(BYID[id])); row.dataset.loaded = '1'; }
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ── 시작 ────────────────────────────────────────────── */
  function boot() {
    bind();
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () { });
      });
    }
    var cached = memRec;
    var p = idbBroken ? Promise.resolve(null) : idbGet(REC).catch(function (e) { idbBroken = true; return null; });
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
      refreshDlgInfoSafe();
    });
  }
  function refreshDlgInfoSafe() { try { refreshDlgInfo(); } catch (e) { } }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
