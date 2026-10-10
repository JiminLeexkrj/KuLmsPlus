// LMS 데이터 수집
// - Canvas API: 로그인된 브라우저 세션 쿠키로 호출 (과목, 과제, 퀴즈, 일정)
// - LearningX API: xn_api_token으로 호출 (온라인 강의의 열람·출석·지각 기간)

export const BASE = 'https://mylms.korea.ac.kr';

// 모듈 아이템 URL의 external_tools/sessionless_launch?id=2 에서 확인한 LearningX 도구 ID
const LEARNINGX_TOOL_ID = 2;

// 토큰 만료가 이 시간 안으로 남았으면 미리 새로 받는다
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

export class LmsError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code; // 'login' | 'token' | 'network'
  }
}

async function parseJson(res) {
  return JSON.parse((await res.text()).replace(/^while\(1\);/, ''));
}

async function canvas(path) {
  let res;
  try {
    res = await fetch(BASE + path, { credentials: 'include', headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new LmsError('network', err.message);
  }
  if (res.status === 401) throw new LmsError('login');
  if (!res.ok) throw new LmsError('network', `${path} → HTTP ${res.status}`);
  return { res, body: await parseJson(res) };
}

// Canvas는 Link 헤더로 다음 페이지를 알려준다
async function canvasAll(path) {
  let items = [];
  let next = path;
  while (next) {
    const { res, body } = await canvas(next);
    items = items.concat(body);
    const match = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/);
    next = match ? match[1].replace(BASE, '') : null;
  }
  return items;
}

function tokenExpiresAt(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.exp * 1000;
  } catch {
    return 0;
  }
}

async function readXnCookie() {
  const cookie = await chrome.cookies.get({ url: BASE, name: 'xn_api_token' });
  return cookie?.value;
}

// LearningX 과목 메뉴를 LTI로 실행하면 응답 쿠키로 xn_api_token이 새로 발급된다.
// 토큰은 사용자 단위라 아무 과목으로 한 번만 실행하면 모든 과목에 쓸 수 있다.
async function launchLearningX(courseId) {
  const { body } = await canvas(
    `/api/v1/courses/${courseId}/external_tools/sessionless_launch?id=${LEARNINGX_TOOL_ID}`,
  );
  const page = await fetch(body.url, { credentials: 'include' });
  const doc = new DOMParser().parseFromString(await page.text(), 'text/html');
  const form = [...doc.forms].find((f) => f.querySelector('input[name="oauth_signature"]'));
  if (!form) throw new LmsError('token', 'LTI 실행 폼을 찾지 못했습니다.');

  const fields = new URLSearchParams();
  for (const input of form.querySelectorAll('input[name]')) fields.append(input.name, input.value);
  const action = new URL(form.getAttribute('action'), page.url).href;
  await fetch(action, { method: 'POST', body: fields, credentials: 'include' });
}

async function getXnToken(courseId, { force = false } = {}) {
  let token = await readXnCookie();
  if (!force && token && tokenExpiresAt(token) - Date.now() > TOKEN_MARGIN_MS) return token;
  await launchLearningX(courseId);
  token = await readXnCookie();
  if (!token) throw new LmsError('token', '토큰 쿠키가 발급되지 않았습니다.');
  return token;
}

async function learningx(path, token) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  // LearningX는 만료되거나 잘못된 토큰에 400 "Invalid request." 페이지를 돌려준다
  if ([400, 401, 403].includes(res.status)) throw new LmsError('token');
  if (!res.ok) throw new LmsError('network', `${path} → HTTP ${res.status}`);
  return parseJson(res);
}

// "262R (서울-학부)자료구조(영강)(DATA STRUCTURE(English))-01분반" → "자료구조(영강)"
export function shortCourseName(name) {
  let s = name
    .replace(/^\S+\s*\([^)]*\)\s*/, '')
    .replace(/-\s*\S+분반$/, '')
    .replace(/^\[[^\]]*\]\s*/, '')
    .trim();
  // 끝의 영문 병기 괄호(중첩 괄호 포함)를 떼어낸다
  if (s.endsWith(')')) {
    let depth = 0;
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i] === ')') depth++;
      else if (s[i] === '(' && --depth === 0) {
        const inner = s.slice(i + 1, -1);
        if (!/[가-힣]/.test(inner) && i > 0) s = s.slice(0, i).trim();
        break;
      }
    }
  }
  return s || name;
}

const abs = (url) => (url && url.startsWith('/') ? BASE + url : url);

function fromPlanner(item) {
  const p = item.plannable ?? {};
  const kind = {
    assignment: 'assignment',
    quiz: 'quiz',
    discussion_topic: 'assignment',
    calendar_event: 'event',
  }[item.plannable_type];
  if (!kind) return [];
  const at = kind === 'event' ? p.start_at ?? item.plannable_date : p.due_at ?? item.plannable_date;
  if (!at) return [];
  const done =
    Boolean(item.submissions?.submitted) || Boolean(item.planner_override?.marked_complete);
  return [
    {
      key: `${item.plannable_type}-${item.plannable_id}`,
      courseId: item.course_id,
      kind,
      stage: kind === 'event' ? 'event' : 'due',
      label: { assignment: '과제', quiz: '퀴즈', event: '일정' }[kind],
      title: p.title ?? '(제목 없음)',
      at,
      url: abs(item.html_url),
      done,
    },
  ];
}

// 영상 하나를 열람 시작·출석 마감·지각 마감·열람 종료 표시로 나눈다
function fromVideo(courseId, moduleItem) {
  const c = moduleItem.content_data ?? {};
  const attendance = Boolean(c.use_attendance);
  const done =
    moduleItem.completed === true || ['attendance', 'late'].includes(moduleItem.attendance_status);
  const base = {
    courseId,
    kind: 'video',
    title: moduleItem.title,
    url: `${BASE}/courses/${courseId}/modules/items/${moduleItem.module_item_id}`,
    done,
    attendance,
    window: { unlock: c.unlock_at, due: c.due_at, late: c.late_at, lock: c.lock_at },
  };
  const sameMinute = (a, b) => a && b && Math.abs(new Date(a) - new Date(b)) < 60_000;
  const marks = [];
  const add = (stage, at, label) =>
    at && marks.push({ ...base, key: `video-${moduleItem.module_item_id}-${stage}`, stage, at, label });

  // 마감 없이 공개일만 있는 영상(실시간 강의 녹화본 등)은 공개일 하나만 표시한다
  if (!c.due_at && !c.late_at && !c.lock_at) {
    add('open', c.unlock_at, '영상 공개');
    return marks;
  }
  add('unlock', c.unlock_at, '열람 시작');
  add('due', c.due_at, attendance ? '출석 마감' : '학습 기한');
  if (!sameMinute(c.late_at, c.due_at)) add('late', c.late_at, '지각 마감');
  if (!sameMinute(c.lock_at, c.due_at) && !sameMinute(c.lock_at, c.late_at)) {
    add('lock', c.lock_at, '열람 종료');
  }
  return marks;
}

export async function loadAll({ onProgress = () => {} } = {}) {
  onProgress('과목 목록을 불러오는 중');
  const courses = (await canvasAll('/api/v1/courses?enrollment_state=active&per_page=100'))
    .filter((c) => c.name)
    .map((c) => ({ id: c.id, name: shortCourseName(c.name), fullName: c.name }));

  const now = Date.now();
  const day = 86_400_000;
  const start = new Date(now - 120 * day).toISOString().slice(0, 10);
  const end = new Date(now + 180 * day).toISOString().slice(0, 10);

  onProgress('과제와 일정을 불러오는 중');
  const planner = await canvasAll(
    `/api/v1/planner/items?start_date=${start}&end_date=${end}&per_page=100`,
  );
  const marks = planner.flatMap(fromPlanner);

  const warnings = [];
  if (courses.length) {
    onProgress('온라인 강의 기간을 불러오는 중');
    try {
      let token = await getXnToken(courses[0].id);
      const fetchModules = (id) =>
        learningx(`/learningx/api/v1/courses/${id}/modules?include_detail=true`, token);
      for (const course of courses) {
        let modules;
        try {
          modules = await fetchModules(course.id);
        } catch (err) {
          if (err.code !== 'token') throw err;
          token = await getXnToken(course.id, { force: true });
          modules = await fetchModules(course.id);
        }
        // 퀴즈는 Canvas 플래너에도 있으므로 영상(attendance_item)만 가져온다
        for (const m of modules) {
          for (const item of m.module_items ?? []) {
            if (item.content_type === 'attendance_item') marks.push(...fromVideo(course.id, item));
          }
        }
      }
    } catch (err) {
      if (err.code === 'login') throw err;
      warnings.push(err.code === 'token' ? 'token' : 'learningx');
      console.error('LearningX', err);
    }
  }

  return { fetchedAt: new Date().toISOString(), courses, marks, warnings };
}
