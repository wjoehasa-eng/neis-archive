/**
 * Y공작소 아카이브 · 비공개 드라이브 전달용 Apps Script
 * ─────────────────────────────────────────────────────────────
 * 하는 일: 내 구글 드라이브의 비공개 JSON 파일을 읽어, 이 스크립트의 주소로 온 요청에만 돌려준다.
 *           파일은 공유하지 않는다. 이 스크립트가 '나' 권한으로 읽어 전달할 뿐이다.
 *
 * 준비: ① 아래 FILE_NAME 이 드라이브 파일 이름과 같은지 확인
 *       ② 필요하면 ACCESS_KEY 에 긴 문장을 넣고, 앱 설정의 '접근 키'에도 같은 값을 넣는다
 *       ③ 배포 → 새 배포 → 웹앱 · 실행: 나 · 액세스: 모든 사용자
 *
 * 주의: 배포 주소를 아는 사람은 이 파일을 읽을 수 있다. 주소는 남에게 알려 주지 말 것.
 *       ACCESS_KEY 를 채우면 주소 + 키가 모두 있어야 읽을 수 있다.
 */

var FILE_NAME = 'neis-y2026-archive.json';
var ACCESS_KEY = '';   // 비워 두면 주소만으로 접근. 보안을 더하려면 긴 문장을 넣으세요.

function doPost(e) {
  try {
    var body = {};
    try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { body = {}; }
    if (!keyOk_(body.key)) return out_({ ok: false, error: '접근 키가 맞지 않습니다. 앱 설정의 접근 키를 확인하세요.' });

    var action = body.action || 'get';
    if (action === 'ping' || action === 'info') return out_(info_());
    if (action !== 'get') return out_({ ok: false, error: '지원하지 않는 요청입니다' });

    var file = newest_();
    if (!file) return out_({ ok: false, error: '드라이브에 ' + FILE_NAME + ' 파일이 없습니다' });
    var text = file.getBlob().getDataAsString('utf-8');
    if (!text || text.charAt(0) !== '{') return out_({ ok: false, error: '파일이 JSON 형식이 아닙니다' });
    return out_({
      ok: true,
      name: file.getName(),
      updated: file.getLastUpdated().toISOString(),
      size: text.length,
      text: text
    });
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  }
}

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (!keyOk_(p.key)) return out_({ ok: false, error: '접근 키가 맞지 않습니다' });
    if (p.action === 'get') return doPost({ postData: { contents: JSON.stringify({ action: 'get', key: p.key }) } });
    return out_(info_());
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  }
}

/** 주소를 브라우저에 열었을 때 확인용 요약(데이터 본문은 보내지 않는다) */
function info_() {
  var file = newest_();
  if (!file) return { ok: false, error: '드라이브에 ' + FILE_NAME + ' 파일이 없습니다' };
  return {
    ok: true,
    app: 'neis-y-archive',
    name: file.getName(),
    updated: file.getLastUpdated().toISOString(),
    size: file.getSize()
  };
}

function newest_() {
  var it = DriveApp.getFilesByName(FILE_NAME);
  var best = null;
  while (it.hasNext()) {
    var f = it.next();
    if (f.isTrashed()) continue;
    if (!best || f.getLastUpdated().getTime() > best.getLastUpdated().getTime()) best = f;
  }
  return best;
}

function keyOk_(given) {
  if (!ACCESS_KEY) return true;
  return String(given || '') === ACCESS_KEY;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
