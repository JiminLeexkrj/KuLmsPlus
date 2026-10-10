import { BASE, loadAll } from './lms.js';

const TZ = 'Asia/Seoul';
const MAX_PER_DAY = 4;
const UPCOMING_DAYS = 14;
const COURSE_COLORS = ['#2f6fde', '#16946f', '#d4782a', '#8a55c7', '#d0447a', '#2c9bb3', '#7c8a26', '#b0802a'];
const NO_COURSE_COLOR = '#8a8a90';

const STAGE_FILTERS = [
  ['video-due', '영상 출석 마감'],
  ['video-late', '영상 지각 마감'],
  ['video-lock', '영상 열람 종료'],
  ['video-unlock', '영상 열람 시작'],
  ['video-open', '영상 공개 (마감 없음)'],
  ['assignment', '과제'],
  ['quiz', '퀴즈'],
  ['event', '수업 일정'],
];
const DEFAULT_PREFS = { hiddenCourses: [], hiddenStages: ['video-unlock'], hideDone: false };

const state = {
  data: null,
  prefs: { ...DEFAULT_PREFS },
  month: null, // { y, m } (m: 0-11, KST 기준)
  loading: false,
};

// ---------- 날짜 (모두 한국 시간 기준) ----------

const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const shortDateFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, month: 'numeric', day: 'numeric', weekday: 'short' });
const syncFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const dayKey = (d) => dayKeyFmt.format(new Date(d));
const keyToUtc = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const daysBetween = (fromKey, toKey) => Math.round((keyToUtc(toKey) - keyToUtc(fromKey)) / 86_400_000);

function ddayLabel(at) {
  const n = daysBetween(dayKey(Date.now()), dayKey(at));
  if (n === 0) return '오늘';
  if (n === 1) return '내일';
  return `D-${n}`;
}

// ---------- DOM 도우미 ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

const $ = (id) => document.getElementById(id);

// ---------- 표시 규칙 ----------

function courseColor(courseId) {
  const i = state.data?.courses.findIndex((c) => c.id === courseId) ?? -1;
  return i < 0 ? NO_COURSE_COLOR : COURSE_COLORS[i % COURSE_COLORS.length];
}

function courseName(courseId) {
  return state.data?.courses.find((c) => c.id === courseId)?.name ?? '개인 일정';
}

const filterKey = (mark) => (mark.kind === 'video' ? `video-${mark.stage}` : mark.kind);

function isVisible(mark) {
  const { hiddenCourses, hiddenStages, hideDone } = state.prefs;
  if (hiddenCourses.includes(mark.courseId)) return false;
  if (hiddenStages.includes(filterKey(mark))) return false;
  if (hideDone && mark.done) return false;
  return true;
}

function shortTag(mark) {
  if (mark.kind === 'event') return timeFmt.format(new Date(mark.at));
  if (mark.kind !== 'video') return mark.label;
  return { unlock: '시작', open: '공개', due: mark.attendance ? '출석' : '기한', late: '지각', lock: '종료' }[mark.stage];
}

// 마감이 지났는데 완료하지 않은 항목
function isMissed(mark) {
  return !mark.done && (mark.stage === 'due' || mark.stage === 'late') && new Date(mark.at) < Date.now();
}

function markTooltip(mark) {
  const when = `${shortDateFmt.format(new Date(mark.at))} ${timeFmt.format(new Date(mark.at))}`;
  return [mark.title, `${courseName(mark.courseId)}, ${mark.label}`, when, mark.done ? '완료함' : '']
    .filter(Boolean)
    .join('\n');
}

function markChip(mark) {
  return h(
    'a',
    {
      class: ['mark', mark.done && 'done', isMissed(mark) && 'missed'].filter(Boolean).join(' '),
      'data-kind': mark.kind,
      'data-stage': mark.stage,
      style: `--c: ${courseColor(mark.courseId)}`,
      href: mark.url,
      target: '_blank',
      rel: 'noopener',
      title: markTooltip(mark),
    },
    h('span', { class: 'tag' }, shortTag(mark)),
    h('span', { class: 'name' }, mark.title),
  );
}

// ---------- 월간 캘린더 ----------

function marksByDay() {
  const map = new Map();
  for (const mark of state.data?.marks ?? []) {
    if (!isVisible(mark)) continue;
    const key = dayKey(mark.at);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(mark);
  }
  // 칸이 좁으므로 마감을 먼저, 완료한 항목은 맨 뒤로 보낸다
  const rank = (m) => (m.done ? 10 : 0) + ({ due: 0, late: 0, lock: 1, event: 2 }[m.stage] ?? 3);
  for (const list of map.values()) {
    list.sort((a, b) => rank(a) - rank(b) || new Date(a.at) - new Date(b.at));
  }
  return map;
}

function renderGrid() {
  const { y, m } = state.month;
  $('month-title').textContent = `${y}년 ${m + 1}월`;

  const first = Date.UTC(y, m, 1);
  const startOffset = new Date(first).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cellCount = Math.ceil((startOffset + daysInMonth) / 7) * 7;
  const todayKey = dayKey(Date.now());
  const byDay = marksByDay();

  const grid = $('grid');
  grid.replaceChildren();
  grid.style.setProperty('--rows', cellCount / 7);

  for (let i = 0; i < cellCount; i++) {
    const date = new Date(first + (i - startOffset) * 86_400_000);
    const key = date.toISOString().slice(0, 10);
    const marks = byDay.get(key) ?? [];
    const inMonth = date.getUTCMonth() === m;
    const shown = marks.slice(0, MAX_PER_DAY);
    const rest = marks.length - shown.length;

    grid.append(
      h(
        'div',
        {
          class: ['day', !inMonth && 'outside', key === todayKey && 'today', date.getUTCDay() === 0 && 'sun', date.getUTCDay() === 6 && 'sat']
            .filter(Boolean)
            .join(' '),
          'aria-label': `${date.getUTCMonth() + 1}월 ${date.getUTCDate()}일, ${marks.length}개 항목`,
        },
        h('span', { class: 'date' }, String(date.getUTCDate())),
        h('div', { class: 'marks' }, shown.map(markChip)),
        rest > 0 && h('button', { type: 'button', class: 'more', onclick: () => openDay(key, marks) }, `${rest}개 더 보기`),
      ),
    );
  }
}

function openDay(key, marks) {
  const [, mo, d] = key.split('-').map(Number);
  $('day-dialog-title').textContent = `${mo}월 ${d}일`;
  $('day-dialog-list').replaceChildren(
    ...marks.map((mark) =>
      h('li', {}, h('span', { class: 'time' }, timeFmt.format(new Date(mark.at))), markChip(mark), h('span', { class: 'course' }, courseName(mark.courseId))),
    ),
  );
  $('day-dialog').showModal();
}

// ---------- 다가오는 마감 ----------

// 영상은 표시(출석/지각/종료)가 여러 개라 영상 하나당 가장 가까운 다음 마감 한 줄로 묶는다
function upcomingEntries() {
  const now = Date.now();
  const limit = now + UPCOMING_DAYS * 86_400_000;
  const byEntity = new Map();
  for (const mark of state.data?.marks ?? []) {
    if (mark.done || mark.stage === 'unlock' || mark.stage === 'open' || mark.kind === 'event') continue;
    if (state.prefs.hiddenCourses.includes(mark.courseId)) continue;
    const at = new Date(mark.at).getTime();
    if (at < now || at > limit) continue;
    const id = mark.kind === 'video' ? mark.url : mark.key;
    const prev = byEntity.get(id);
    if (!prev || at < new Date(prev.at).getTime()) byEntity.set(id, mark);
  }
  return [...byEntity.values()].sort((a, b) => new Date(a.at) - new Date(b.at));
}

// 지금이 출석인정 / 지각인정 / 열람만 가능 구간 중 어디인지
function videoPhase(mark, now = Date.now()) {
  const w = mark.window;
  const t = (s) => (s ? new Date(s).getTime() : null);
  const [unlock, due, late, lock] = [t(w.unlock), t(w.due), t(w.late), t(w.lock)];
  if (unlock && now < unlock) return '열람 전';
  if (due && now <= due) return mark.attendance ? '출석인정 기간' : '학습 기간';
  if (late && now <= late) return '지각인정 기간';
  if (lock && now <= lock) return '열람만 가능';
  return '열람 종료';
}

function windowBar(mark) {
  const w = mark.window;
  const t = (s) => (s ? new Date(s).getTime() : null);
  const start = t(w.unlock);
  const end = Math.max(...[w.due, w.late, w.lock].map(t).filter(Boolean));
  if (!start || !end || end <= start) return null;

  const pct = (x) => `${(((x - start) / (end - start)) * 100).toFixed(2)}%`;
  const due = t(w.due) ?? end;
  const late = t(w.late);
  const segments = [h('span', { class: 'seg attend', style: `left:0;width:${pct(due)}` })];
  if (late && late > due) {
    segments.push(h('span', { class: 'seg late', style: `left:${pct(due)};width:calc(${pct(late)} - ${pct(due)})` }));
  }
  const viewFrom = late && late > due ? late : due;
  if (end > viewFrom) {
    segments.push(h('span', { class: 'seg view', style: `left:${pct(viewFrom)};width:calc(100% - ${pct(viewFrom)})` }));
  }
  const now = Math.min(Math.max(Date.now(), start), end);
  segments.push(h('span', { class: 'now', style: `left:${pct(now)}` }));

  const describe = [
    `열람 시작 ${shortDateFmt.format(new Date(start))}`,
    `${mark.attendance ? '출석 마감' : '학습 기한'} ${shortDateFmt.format(new Date(due))}`,
    late ? `지각 마감 ${shortDateFmt.format(new Date(late))}` : null,
    w.lock ? `열람 종료 ${shortDateFmt.format(new Date(w.lock))}` : null,
  ].filter(Boolean).join(', ');
  return h('div', { class: 'window', role: 'img', 'aria-label': describe, title: describe }, segments);
}

function renderUpcoming() {
  const list = $('upcoming-list');
  const entries = upcomingEntries();
  if (!state.data) {
    list.replaceChildren();
    return;
  }
  if (!entries.length) {
    list.replaceChildren(h('li', { class: 'empty' }, `앞으로 ${UPCOMING_DAYS}일 동안 남은 마감이 없습니다.`));
    return;
  }
  list.replaceChildren(
    ...entries.map((mark) => {
      const date = new Date(mark.at);
      const n = daysBetween(dayKey(Date.now()), dayKey(mark.at));
      return h(
        'li',
        { class: ['up', n <= 1 && 'soon'].filter(Boolean).join(' '), style: `--c: ${courseColor(mark.courseId)}` },
        h(
          'div',
          { class: 'up-when' },
          h('strong', {}, ddayLabel(mark.at)),
          h('span', {}, `${shortDateFmt.format(date)} ${timeFmt.format(date)}`),
        ),
        h('a', { class: 'up-title', href: mark.url, target: '_blank', rel: 'noopener' }, mark.title),
        h(
          'div',
          { class: 'up-meta' },
          h('span', { class: 'course-dot' }),
          h('span', {}, courseName(mark.courseId)),
          h('span', { class: 'up-label' }, mark.kind === 'video' ? `${mark.label}, 지금은 ${videoPhase(mark)}` : mark.label),
        ),
        mark.kind === 'video' && windowBar(mark),
      );
    }),
  );
}

// ---------- 필터 ----------

function savePrefs() {
  chrome.storage.local.set({ prefs: state.prefs });
}

function toggleIn(list, value, on) {
  const set = new Set(list);
  on ? set.delete(value) : set.add(value);
  return [...set];
}

function renderFilters() {
  const courses = state.data?.courses ?? [];
  $('course-filter').replaceChildren(
    ...courses.map((c) =>
      h(
        'li',
        {},
        h(
          'label',
          { class: 'check', style: `--c: ${courseColor(c.id)}`, title: c.fullName },
          h('input', {
            type: 'checkbox',
            checked: !state.prefs.hiddenCourses.includes(c.id),
            onchange: (e) => {
              state.prefs.hiddenCourses = toggleIn(state.prefs.hiddenCourses, c.id, e.target.checked);
              savePrefs();
              renderAll();
            },
          }),
          h('span', { class: 'swatch' }),
          h('span', {}, c.name),
        ),
      ),
    ),
  );

  $('stage-filter').replaceChildren(
    ...STAGE_FILTERS.map(([key, label]) =>
      h(
        'li',
        {},
        h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: !state.prefs.hiddenStages.includes(key),
            onchange: (e) => {
              state.prefs.hiddenStages = toggleIn(state.prefs.hiddenStages, key, e.target.checked);
              savePrefs();
              renderAll();
            },
          }),
          h('span', { class: 'legend', 'data-legend': key }),
          h('span', {}, label),
        ),
      ),
    ),
  );

  $('hide-done').checked = state.prefs.hideDone;
}

// ---------- 상태 표시 ----------

function setBanner(kind) {
  const banner = $('banner');
  const lmsLink = (text) => h('a', { href: BASE, target: '_blank', rel: 'noopener' }, text);
  const messages = {
    login: ['LMS에 로그인되어 있지 않습니다. ', lmsLink('LMS에서 로그인'), '한 뒤 새로고침을 누르세요.'],
    token: [
      '온라인 강의 기간을 불러오지 못했습니다. ',
      lmsLink('LMS'),
      '에서 아무 강의실이나 들어가 왼쪽 메뉴의 출결현황(Attendance)을 한 번 연 뒤 새로고침을 누르세요. 과제와 일정은 그대로 표시됩니다.',
    ],
    learningx: ['온라인 강의 기간을 불러오는 중 오류가 났습니다. 과제와 일정만 표시합니다. 잠시 후 새로고침을 누르세요.'],
    network: ['LMS 서버에 연결하지 못했습니다. 마지막으로 불러온 내용을 표시합니다. 잠시 후 새로고침을 누르세요.'],
  };
  if (!kind) {
    banner.hidden = true;
    return;
  }
  banner.replaceChildren(...messages[kind]);
  banner.hidden = false;
}

function setSyncStatus(text) {
  $('sync-status').textContent = text;
}

function renderAll() {
  renderFilters();
  renderGrid();
  renderUpcoming();
}

// ---------- 데이터 갱신 ----------

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  $('refresh').disabled = true;
  try {
    const data = await loadAll({ onProgress: (msg) => setSyncStatus(`${msg}…`) });
    state.data = data;
    await chrome.storage.local.set({ cache: data });
    setBanner(data.warnings[0]);
    renderAll();
  } catch (err) {
    console.error(err);
    setBanner(err.code ?? 'network');
  } finally {
    state.loading = false;
    $('refresh').disabled = false;
    setSyncStatus(state.data ? `${syncFmt.format(new Date(state.data.fetchedAt))} 기준` : '');
  }
}

function shiftMonth(delta) {
  const d = new Date(Date.UTC(state.month.y, state.month.m + delta, 1));
  state.month = { y: d.getUTCFullYear(), m: d.getUTCMonth() };
  renderGrid();
}

function goToday() {
  const [y, m] = dayKey(Date.now()).split('-').map(Number);
  state.month = { y, m: m - 1 };
  renderGrid();
}

async function init() {
  const { prefs, cache } = await chrome.storage.local.get(['prefs', 'cache']);
  state.prefs = { ...DEFAULT_PREFS, ...prefs };
  state.data = cache ?? null;
  goToday();
  renderAll();
  if (cache) setSyncStatus(`${syncFmt.format(new Date(cache.fetchedAt))} 기준`);

  $('prev').addEventListener('click', () => shiftMonth(-1));
  $('next').addEventListener('click', () => shiftMonth(1));
  $('today').addEventListener('click', goToday);
  $('refresh').addEventListener('click', refresh);
  $('hide-done').addEventListener('change', (e) => {
    state.prefs.hideDone = e.target.checked;
    savePrefs();
    renderAll();
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, dialog[open]')) return;
    if (e.key === 'ArrowLeft') shiftMonth(-1);
    if (e.key === 'ArrowRight') shiftMonth(1);
  });

  refresh();
}

init();
