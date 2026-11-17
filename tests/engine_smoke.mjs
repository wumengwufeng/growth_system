/* 无头冒烟测试：在 node 里按 index.html 的顺序加载真实 js 文件，用最小 DOM/fetch 桩驱动引擎。
   验证点：settle() 不再抛 TDZ、完成幂等、补交宽限、突发收回不再静默、磁盘冲突合并。
   运行：node tests/engine_smoke.mjs */
import fs from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

let fails = 0;
// extra 只在失败时打印：不写出来的话，失败原因（哪条断言、实际值多少）就丢了，
// 得再跑一遍去猜 —— 这条是踩过才加的
const A = (name, cond, extra) => {
  if (!cond) { fails++; console.log('FAIL:', name, extra === undefined ? '' : '→ ' + extra); }
  else console.log('ok:', name);
};

/* ── 0. 先跑 core.js 的纯函数自检 ──
   这些断言（约 125 条）此前只能手动 `node -e` 触发，从不参与自动回归，
   导致 core.js 出现回归时引擎测试照样全绿。这里把它接进同一条流水线。 */
{
  const coreApi = new Function(read('js/core.js').replace("'use strict';", '') + ';return { selftest };')();
  const realAssert = console.assert;
  const caught = [];
  console.assert = (cond, msg) => { if (!cond) caught.push(String(msg)); };
  let passed = false;
  try { passed = coreApi.selftest() === true; }
  finally { console.assert = realAssert; }
  A('core.selftest() 全部通过', passed && caught.length === 0, caught.slice(0, 3).join(' | '));
}

function makeSandbox({ now, save, fetchImpl } = {}) {
  const store = new Map();
  const els = new Map();
  // 轻量 DOM stub：appendChild/children 要像真 DOM 一样联动，
  // 否则 toast 的「最多 3 条」上限逻辑在沙箱里会抛错（曾因此整块测试挂掉）
  const mkEl = id => {
    const el = {
      id, textContent: '', innerHTML: '', value: '', hidden: false, disabled: false,
      style: {}, dataset: {}, type: 'text', files: [],
      children: [], childNodes: [],
      setAttribute() {}, addEventListener() {},
      appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
      remove() {
        const p = el.__parent;
        if (p) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); }
      },
      querySelector: () => ({ value: '' }), click() {},
    };
    Object.defineProperty(el, 'firstElementChild', {
      get() { return el.children[0] || null; },
    });
    return el;
  };
  const document = {
    getElementById: id => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); },
    querySelectorAll: () => [],
    createElement: () => mkEl('x'),
    addEventListener() {},
    body: { dataset: {}, style: {} },
  };
  const toasts = [];
  const logs = [];
  const ctx = {
    console: { log: (...a) => logs.push(a.join(' ')), warn: () => {}, assert() {}, error: (...a) => logs.push('ERR ' + a.join(' ')) },
    document,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    },
    fetch: fetchImpl || (async () => ({ ok: false, status: 404, json: async () => null, headers: { get: () => null } })),
    setTimeout: (fn) => { /* 不真的落盘 */ return 0; },
    clearTimeout: () => {},
    setInterval: () => 0,
    Date: class extends Date { constructor(...a) { if (a.length === 0 && now) super(now()); else super(...a); } static now() { return now ? now() : Date.now(); } },
    Math, JSON, String, Number, Object, Array, RegExp, parseInt, parseFloat, confirm: () => true,
    AudioContext: null,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['js/core.js', 'js/ai.js', 'js/state.js', 'js/engine.js', 'js/ui.js']) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  // 用可观测的 UI 桩替换真实 UI（ui.js 里 DOM 操作在无头环境不适用）
  ctx.__toasts = toasts;
  vm.runInContext(`
    window.UI = {
      toast: (t,c)=>__toasts.push({t,c}), ding: ()=>{}, renderAll: ()=>{}, renderTasks: ()=>{}
    };`, ctx);
  return { ctx, store, toasts, els, ev: (code) => vm.runInContext(code, ctx) };
}

/* ── 1. TDZ：新的一天首次 settle 不应抛错 ── */
{
  const { ctx, store, logs, ev } = makeSandbox({ now: () => new Date('2026-10-28T10:30:00').getTime() });
  const S = ev('S');
  S.created = 1792999742652;
  S.settings.dayStart = '09:00'; S.settings.dayEnd = '22:00';
  let threw = null;
  await ev('settle()').catch(e => { threw = e; });
  A('新的一天 settle() 不抛异常', threw === null);
  A('当天已建 day 记录', !!S.days['2026-10-28']);
  A('当天有每日快照', !!S.days['2026-10-28'].snap);
  A('快照已标记 dirty→已落盘(localStorage)', (store.get('growth_system_v1') || '').includes('"snap"'));
}

/* ── 2. 完成幂等：重复调用不双发奖励 ── */
{
  const { ctx, ev } = makeSandbox({ now: () => new Date('2026-10-28T10:30:00').getTime() });
  const S = ev('S');
  // 隔离每日赐福：把当天的赐福固定为"无加成"，否则本用例的数值会被倍率影响
  ev("BLESSINGS.length=0; BLESSINGS.push({id:'none',name:'无',desc:'',mult:{}});");
  S.days['2026-10-28'] = { slots: [{ at: 600, kind: 'side', status: 'pending', settledAt: 0,
    task: { title: 'T', desc: 'd', category: '智力', difficulty: 2, minutes: 30, kind: 'side', rarity: 'common' },
    issuedAt: Date.now() - 5*60e3, deadline: Date.now() + 3600e3 }] };
  const before = { coins: S.player.coins, exp: S.player.exp, done: S.stats.done };
  ev("completeTask('2026-10-28', 0, '第一次')");
  const mid = { coins: S.player.coins, exp: S.player.exp, done: S.stats.done };
  ev("completeTask('2026-10-28', 0, '第二次')");
  const after = { coins: S.player.coins, exp: S.player.exp, done: S.stats.done };
  A('完成后奖励已发放', mid.coins === before.coins + 16 && mid.done === before.done + 1, `币 ${before.coins}->${mid.coins}`);
  A('重复完成不再发放（幂等）', after.coins === mid.coins && after.exp === mid.exp && after.done === mid.done);
}

/* ── 3. 补交宽限：昨日刚过截止的任务应保留 pending，而不是立刻 expired ── */
{
  const nowMs = new Date('2026-10-28T09:30:00').getTime();
  const { ctx, ev } = makeSandbox({ now: () => nowMs });
  const S = ev('S');
  S.created = 1792999742652;
  // 昨日任务：截止于 30 分钟前 → 在 2 小时宽限内
  S.days['2026-10-27'] = { tzOffset: -(new Date(nowMs).getTimezoneOffset()),
    slots: [{ at: 1100, kind: 'side', status: 'pending', settledAt: 0,
      task: { title: '昨日任务', desc: '', category: '自律', difficulty: 1, minutes: 10, kind: 'side' },
      issuedAt: nowMs - 12 * 3600e3, deadline: nowMs - 30 * 60e3 }] };
  // 更早的逾期任务：超过宽限 → 应清掉
  S.days['2026-10-26'] = { tzOffset: -(new Date(nowMs).getTimezoneOffset()),
    slots: [{ at: 600, kind: 'side', status: 'pending', settledAt: 0,
      task: { title: '前日任务', desc: '', category: '自律', difficulty: 1, minutes: 10, kind: 'side' },
      issuedAt: nowMs - 40 * 3600e3, deadline: nowMs - 30 * 3600e3 }] };
  await ev('settle()');
  A('宽限期内昨日任务保留 pending（可补交）', S.days['2026-10-27'].slots[0].status === 'pending');
  A('超出宽限的前日任务已失效', S.days['2026-10-26'].slots[0].status === 'expired');
}

/* ── 4. 突发收回：不再静默（toast + 公告），且只播报一次（防每轮 settle 刷屏）── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T20:00:00').getTime() });
  const S = ev('S');
  S.settings.dayStart = '09:00'; S.settings.dayEnd = '22:00';
  const dayStr = '2026-10-28';
  // 10:00 触发、20:00 检查 → 在线超窗 10 小时，走 !offline 的收回分支
  S.days[dayStr] = { tzOffset: -(new Date().getTimezoneOffset()), slots: [
    { at: 600, kind: 'burst', status: 'waiting', notified: false, settledAt: 0 },
  ] };
  const before = ev("__toasts.length");
  await ev('settle()');
  const after1 = ev("__toasts.length");
  const log1 = S.log.filter(l => l.txt.includes('系统已收回')).length;
  A('超窗突发已收回', S.days[dayStr].slots[0].status === 'void', S.days[dayStr].slots[0].status);
  A('收回有 toast 提示', after1 > before, `${before}->${after1}`);
  A('收回有系统公告', log1 >= 1, log1);
  await ev('settle()');
  await ev('settle()');
  const after3 = ev("__toasts.length");
  const log3 = S.log.filter(l => l.txt.includes('系统已收回')).length;
  A('突发收回不重复播报', after3 === after1 && log3 === log1, `toast ${after1}->${after3}, log ${log1}->${log3}`);
}

/* ── 5. 磁盘冲突：服务端 409 时不应覆盖本地，且采用更新的那份 ── */
{
  const newer = { created: 1, updatedAt: 9e12, player: { name: '磁盘版', level: 9, exp: 0, coins: 999, attrs: { 体质: 1, 智力: 2, 精神: 3, 自律: 4 } }, settings: { theme: 'dark', page: 'today' }, days: {}, shop: [], log: [] };
  const fetchImpl = async () => ({
    ok: false, status: 409,
    headers: { get: h => (h === 'X-Save-Mtime' ? '12345' : null) },
    json: async () => newer,
  });
  const { ctx, store, ev } = makeSandbox({ now: () => new Date('2026-10-28T10:30:00').getTime(), fetchImpl });
  const S0 = ev('S');
  S0.updatedAt = 1; // 本地更旧
  await ev('syncDisk()');
  A('409 后采用磁盘上更新的存档', ev('S').player.name === '磁盘版');
  A('合并结果已写回 localStorage', (store.get('growth_system_v1') || '').includes('磁盘版'));
}

/* ── 6. 分段推进：领半奖 → 完成剩余只补另一半，总额等于整奖 ── */
{
  const { ev, ctx } = makeSandbox({ now: () => new Date('2026-10-28T10:30:00').getTime() });
  const S = ev('S');
  S.days['2026-10-28'] = { slots: [{ at: 600, kind: 'side', status: 'pending', settledAt: 0,
    task: { title: '长任务', desc: '', category: '智力', difficulty: 2, minutes: 40, kind: 'side' },
    issuedAt: Date.now() - 5*60e3, deadline: Date.now() + 3600e3 }] };
  const before = { coins: S.player.coins, exp: S.player.exp, attr: S.player.attrs['智力'] };
  ev("startPartial('2026-10-28', 0)");
  const mid = { coins: S.player.coins, exp: S.player.exp, attr: S.player.attrs['智力'], status: S.days['2026-10-28'].slots[0].status };
  A('半奖后进入 partial', mid.status === 'partial');
  A('半奖发放一半金币', mid.coins === before.coins + 8, `${before.coins}->${mid.coins}`);
  ev("completeTask('2026-10-28', 0, '')");
  const end = { coins: S.player.coins, exp: S.player.exp, attr: S.player.attrs['智力'], status: S.days['2026-10-28'].slots[0].status };
  A('收尾后状态为 done', end.status === 'done');
  A('半奖+收尾 = 整奖（金币）', end.coins - before.coins === 16, `总增 ${end.coins - before.coins}`);
  A('半奖+收尾 = 整奖（属性）', end.attr - before.attr === 8, `总增 ${end.attr - before.attr}`);
  A('半奖+收尾 = 整奖（EXP）', end.exp - before.exp === 30 || S.player.level > 1, `EXP 差额 ${end.exp - before.exp}`);
}

/* ── 7. 短任务不允许分段 ── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T10:30:00').getTime() });
  const S = ev('S');
  S.days['2026-10-28'] = { slots: [{ at: 600, kind: 'side', status: 'pending',
    task: { title: '短任务', desc: '', category: '自律', difficulty: 1, minutes: 10, kind: 'side' },
    issuedAt: Date.now() - 5*60e3, deadline: Date.now() + 3600e3 }] };
  ev("startPartial('2026-10-28', 0)");
  A('短任务不会被拆成 partial', S.days['2026-10-28'].slots[0].status === 'pending');
}

/* ── 8. 成就：完成首个任务即解锁并写入存档 ── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T10:30:00').getTime() });
  const S = ev('S');
  S.days['2026-10-28'] = { slots: [{ at: 600, kind: 'side', status: 'pending',
    task: { title: '首胜', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side' },
    issuedAt: Date.now() - 5*60e3, deadline: Date.now() + 3600e3 }] };
  ev("completeTask('2026-10-28', 0, '')");
  A('完成首任务解锁 first 成就', (S.achievements || []).includes('first'));
  const n1 = S.achievements.length;
  ev('grantAchievements()');
  A('重复检查不会重复记录成就', S.achievements.length === n1);
  A('成就有系统公告', S.log.some(l => l.txt.includes('成就解锁')));
}

/* ── 9. 补交拉力：窗口过半零完成时追加起步任务，且只加一次 ── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T20:00:00').getTime() });
  const S = ev('S');
  S.created = 1792999742652;
  S.settings.dayStart = '09:00'; S.settings.dayEnd = '22:00';
  const today = '2026-10-28';
  // 造一个"全部已失效、窗口已过 60%"的今天
  S.days[today] = { tzOffset: -(new Date().getTimezoneOffset()),
    slots: [{ at: 600, kind: 'side', status: 'expired', settledAt: 1,
      task: { title: '失效任务', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side' },
      issuedAt: 1, deadline: 2 }] };
  await ev('settle()');
  const starter = S.days[today].slots.find(s => s.starter);
  A('追加了起步任务', !!starter);
  A('起步任务是轻量（难度1/≤15分钟）', !!starter && starter.task.difficulty === 1 && starter.task.minutes <= 15);
  A('起步任务可选完成', !!starter && (starter.status === 'pending' || starter.status === 'done'));
  const countBefore = S.days[today].slots.length;
  await ev('settle()');
  A('再跑一轮不重复添加', S.days[today].slots.length === countBefore);
}

/* ── 9b. 起步任务避开近 7 天出现过的标题 ──
   池子小的时候起步任务天天是同一个，这里把候选里除一条以外全部塞进历史 */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T20:00:00').getTime() });
  const S = ev('S');
  S.created = 1792999742652;
  S.settings.dayStart = '09:00'; S.settings.dayEnd = '22:00';
  const today = '2026-10-28';
  const cands = ev("FALLBACK_POOL.filter(t=>t.difficulty===1 && t.minutes<=15).map(t=>t.title)");
  const keep = '深蹲 30 个 × 3 组';
  A('起步候选含预期模板', cands.includes(keep), cands.join('/'));
  const old = cands.filter(t => t !== keep).map(t => ({ task: { title: t, category: '自律', difficulty: 1, minutes: 15 } }));
  S.days['2026-10-26'] = { slots: old.slice(0, 7) };
  S.days['2026-10-27'] = { slots: old.slice(7) };
  S.days[today] = { tzOffset: -(new Date().getTimezoneOffset()),
    slots: [{ at: 600, kind: 'side', status: 'expired', settledAt: 1,
      task: { title: '失效任务', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side' },
      issuedAt: 1, deadline: 2 }] };
  await ev('settle()');
  const starter = S.days[today].slots.find(s => s.starter);
  A('起步任务避开近期出现过的标题', !!starter && starter.task.title === keep, starter && starter.task.title);
}

/* ── 9c. 起步任务：候选全用过时挑最久没出现的那条（不会因此不发） ── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T20:00:00').getTime() });
  const S = ev('S');
  S.created = 1792999742652;
  S.settings.dayStart = '09:00'; S.settings.dayEnd = '22:00';
  const today = '2026-10-28';
  const cands = ev("FALLBACK_POOL.filter(t=>t.difficulty===1 && t.minutes<=15).map(t=>t.title)");
  const oldest = cands[cands.length - 1];
  const all = cands.map(t => ({ task: { title: t, category: '自律', difficulty: 1, minutes: 15 } }));
  S.days['2026-10-20'] = { slots: all.slice(-1) };          // 窗口外，最久没出现
  S.days['2026-10-26'] = { slots: all.slice(0, -1) };       // 窗口内
  S.days[today] = { tzOffset: -(new Date().getTimezoneOffset()),
    slots: [{ at: 600, kind: 'side', status: 'expired', settledAt: 1,
      task: { title: '失效任务', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side' },
      issuedAt: 1, deadline: 2 }] };
  await ev('settle()');
  const starter = S.days[today].slots.find(s => s.starter);
  A('候选全用过时仍发，且挑最久没出现的', !!starter && starter.task.title === oldest, starter && starter.task.title);
}

/* ── 10. 商城进度 & 主题 auto ── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T10:30:00').getTime() });
  A('商城进度 64/200 → 32%', ev('shopProgress(64,200)').pct === 32);
  A('auto 主题可解析为 light/dark', ['light', 'dark'].includes(ev('applyTheme()')));
}

/* ── 11. 主线任务：按「有进展的天数」推进（2026-11-17 改口径） ──
   原来是每完成 1 个任务 +1、目标 30；系统每天只发 2~3 个任务，
   于是「三十天筑基」12 天就刷满。现在一天做几个都只算 1 天。 */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T10:30:00').getTime() });
  const S = ev('S');
  ev("BLESSINGS.length=0; BLESSINGS.push({id:'none',name:'无',desc:'',mult:{}});");
  ev("S.mainQuest={...DEFAULT_MAIN_QUEST, target:3, progress:0, activeDays:[], milestones:[1,2,3], doneMilestones:[], completed:false};");
  const mkSlot = () => ({ at: 600, kind: 'side', status: 'pending', settledAt: 0,
    task: { title: 'M', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side', rarity: 'common' },
    issuedAt: Date.now() - 5*60e3, deadline: Date.now() + 3600e3 });
  S.days['2026-10-26'] = { slots: [mkSlot()] };
  S.days['2026-10-27'] = { slots: [mkSlot()] };
  S.days['2026-10-28'] = { slots: [mkSlot(), mkSlot()] };
  ev("completeTask('2026-10-26', 0, '')");
  A('完成任务记录有进展的一天', S.mainQuest.progress === 1, S.mainQuest.progress);
  A('里程碑 1 已记录', S.mainQuest.doneMilestones.includes(1));
  A('活跃日期入档', JSON.stringify(S.mainQuest.activeDays) === JSON.stringify(['2026-10-26']),
    JSON.stringify(S.mainQuest.activeDays));
  // 同一天再做两个：进度必须原地不动，否则又回到「数任务」的老毛病
  ev("completeTask('2026-10-28', 0, '')");
  ev("completeTask('2026-10-28', 1, '')");
  A('同一天做完两个只算一天', S.mainQuest.progress === 2, S.mainQuest.progress);
  const coinsBefore = S.player.coins;
  ev("completeTask('2026-10-27', 0, '')");
  A('满 3 天主线 completed', S.mainQuest.completed === true);
  A('主线完成发放额外奖励', S.player.coins > coinsBefore + 32, `增 ${S.player.coins - coinsBefore}`);
  A('主线完成有公告', S.log.some(l => l.txt.includes('主线任务')));
}

/* ── 12. 连续签到奖励 ── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T10:30:00').getTime() });
  const S = ev('S');
  // 造 3 天连续完成
  for (const d of ['2026-10-26', '2026-10-27', '2026-10-28']) {
    S.days[d] = { slots: [{ at: 600, kind: 'side', status: 'done', settledAt: 1,
      task: { title: 'x', desc: '', category: '智力', difficulty: 1, minutes: 10, kind: 'side' } }] };
  }
  const before = S.player.coins;
  ev("checkStreakBonus()");
  A('连击 3 天发钻石奖励', S.player.coins === before + 30, `增 ${S.player.coins - before}`);
  A('领取记录写入 streakClaimed', (S.streakClaimed || []).includes(3));
  const again = S.player.coins;
  ev("checkStreakBonus()");
  A('同一档位不重复发放', S.player.coins === again);
}

/* ── 13. 稀有度影响实际结算 ── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T10:30:00').getTime() });
  const S = ev('S');
  ev("BLESSINGS.length=0; BLESSINGS.push({id:'none',name:'无',desc:'',mult:{}});");
  ev("S.mainQuest.completed=true;");  // 排除主线干扰
  S.days['2026-10-28'] = { slots: [{ at: 600, kind: 'side', status: 'pending',
    task: { title: 'E', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side', rarity: 'epic' },
    issuedAt: Date.now() - 5*60e3, deadline: Date.now() + 3600e3 }] };
  const c0 = S.player.coins;
  ev("completeTask('2026-10-28', 0, '')");
  A('史诗任务按 ×1.5 结算', S.player.coins - c0 === 24, `增 ${S.player.coins - c0}（期望 24）`);
  A('史诗任务有专属公告', S.log.some(l => l.txt.includes('史诗')));
}

/* ── 14. 每日赐福影响结算 ── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T10:30:00').getTime() });
  const S = ev('S');
  // 强制当天赐福为"智力 ×2"：直接替换函数，比替换数组可靠（blessingFor 是确定性掷骰）
  ev("blessingFor = () => ({id:'t', name:'测试', desc:'', mult:{智力:2}});");
  ev("S.mainQuest.completed=true;");
  S.days['2026-10-28'] = { slots: [{ at: 600, kind: 'side', status: 'pending',
    task: { title: 'B', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side', rarity: 'common' },
    issuedAt: Date.now() - 5*60e3, deadline: Date.now() + 3600e3 }] };
  const c0 = S.player.coins;
  ev("completeTask('2026-10-28', 0, '')");
  A('赐福倍率计入奖励', S.player.coins - c0 === 32, `增 ${S.player.coins - c0}（期望 32=16×2）`);
  A('公告标注赐福', S.log.some(l => l.txt.includes('赐福')));
}

/* ── 15. 连锁任务 ── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T10:30:00').getTime() });
  const S = ev('S');
  ev("BLESSINGS.length=0; BLESSINGS.push({id:'none',name:'无',desc:'',mult:{}});");
  S.days['2026-10-28'] = { slots: [{ at: 600, kind: 'side', status: 'pending',
    task: { title: 'C', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side', rarity: 'common' },
    issuedAt: Date.now() - 5*60e3, deadline: Date.now() + 3600e3 }] };
  const n0 = S.days['2026-10-28'].slots.length;
  // 强制连锁成立（绕过随机）
  ev("shouldChain = () => true;");
  ev("maybeChain({title:'C', category:'智力', difficulty:2}, '2026-10-28')");
  A('连锁派生新任务', S.days['2026-10-28'].slots.length === n0 + 1);
  A('连锁任务带来源标记', S.days['2026-10-28'].slots[n0].chainedFrom === 'C');
  A('连锁有新公告', S.log.some(l => l.txt.includes('连锁')));
}

/* ── 15b. 连锁不派发当天已出现过的同名任务 ──
   起步任务与连锁任务共用 FALLBACK_POOL，自律类 ≤★1 只有两条，不加过滤会派生重名任务 */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T10:30:00').getTime() });
  const S = ev('S');
  ev("shouldChain = () => true;");
  const done = { title: '快速整理 15 分钟', desc: '', category: '自律', difficulty: 1, minutes: 15, kind: 'side' };
  // 起步任务已经用过同名模板 → 自律类 ≤★1 只剩「清空一个收藏夹」，连锁应改选它
  S.days['2026-10-28'] = { slots: [{ at: 600, kind: 'side', status: 'done', task: { ...done } },
    { at: 610, kind: 'side', starter: true, status: 'done', task: { ...done, starter: true } }] };
  ev(`maybeChain(${JSON.stringify(done)}, '2026-10-28')`);
  const chained = S.days['2026-10-28'].slots[2];
  A('连锁避开当天已用过的同名模板', !!chained && chained.task.title !== done.title, chained && chained.task.title);
  // 候选里只剩已用过的那个 → 宁愿不发，也不能出一条重名任务
  ev(`FALLBACK_POOL.splice(0, FALLBACK_POOL.length, ...FALLBACK_POOL.filter(x=>x.title==='快速整理 15 分钟'));`);
  S.days['2026-10-28'].slots = S.days['2026-10-28'].slots.slice(0, 2);
  ev(`maybeChain(${JSON.stringify(done)}, '2026-10-28')`);
  A('同名模板当日已用完时连锁放弃', S.days['2026-10-28'].slots.length === 2, `共 ${S.days['2026-10-28'].slots.length} 个槽位`);
  A('连锁任务仍保留来源标记', !!chained && chained.chainedFrom === done.title);
}

/* ── 15c. 连锁跨天避让：近 7 天做过的同类模板不再派发 ── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-31T10:30:00').getTime() });
  const S = ev('S');
  ev("shouldChain = () => true;");
  const d1 = ev("FALLBACK_POOL.filter(t=>t.category==='自律' && t.difficulty===1).map(t=>t.title)");
  A('自律★1 候选已扩充到 3 条以上', d1.length >= 3, d1.join('/'));
  const fresh = d1[d1.length - 1];
  const done = { title: d1[0], desc: '', category: '自律', difficulty: 1, minutes: 15, kind: 'side' };
  // 前几天把除最后一条外的候选全用过
  S.days['2026-10-29'] = { slots: d1.slice(0, -1).map(t => ({ status: 'done', task: { title: t, category: '自律', difficulty: 1, minutes: 15 } })) };
  S.days['2026-10-31'] = { slots: [{ at: 600, kind: 'side', status: 'done', task: { ...done } }] };
  ev(`maybeChain(${JSON.stringify(done)}, '2026-10-31')`);
  const chained = S.days['2026-10-31'].slots[1];
  A('连锁避开近 7 天出现过的模板', !!chained && chained.task.title === fresh, chained && chained.task.title);
}

/* ── 16. 语气包影响文案 ── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T10:30:00').getTime() });
  const S = ev('S');
  ev("BLESSINGS.length=0; BLESSINGS.push({id:'none',name:'无',desc:'',mult:{}});");
  S.settings.tone = 'sharp';
  S.days['2026-10-28'] = { slots: [{ at: 600, kind: 'side', status: 'pending',
    task: { title: 'T', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side', rarity: 'common' },
    issuedAt: Date.now() - 5*60e3, deadline: Date.now() + 3600e3 }] };
  ev("completeTask('2026-10-28', 0, '')");
  A('毒舌语气写入完成公告', S.log.some(l => l.txt.includes('总算动了')), S.log[0] && S.log[0].txt);
}

/* ── 17. 已被 #4 合并：突发收回的「播报一次」与「不重复播报」同属一条链路 ── */

/* ── 18. 属性跨级播报与留痕 ── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T10:30:00').getTime() });
  const S = ev('S');
  ev("BLESSINGS.length=0; BLESSINGS.push({id:'none',name:'无',desc:'',mult:{}});");
  ev("S.mainQuest.completed=true;");   // 隔离主线干扰
  // 智力 88，再做一个 ★★ 智力任务 +8 → 96 越过 D 线(90)
  S.player.attrs['智力'] = 88;
  S.days['2026-10-28'] = { slots: [{ at: 600, kind: 'side', status: 'pending',
    task: { title: 'R', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side', rarity: 'common' },
    issuedAt: Date.now() - 5*60e3, deadline: Date.now() + 3600e3 }] };
  const toastBefore = ev("__toasts.length");
  ev("completeTask('2026-10-28', 0, '')");
  A('属性跨级写入 rankUps', (S.rankUps || []).length === 1 && S.rankUps[0].rank === 'D', JSON.stringify(S.rankUps));
  A('跨级记录维度与数值', S.rankUps[0].cat === '智力' && S.rankUps[0].value === 96);
  A('跨级有系统公告', S.log.some(l => l.txt.includes('属性突破')), S.log[0] && S.log[0].txt);
  A('跨级弹 toast', ev("__toasts.length") > toastBefore);

  // 未跨级不应产生新记录
  const n1 = S.rankUps.length;
  S.days['2026-10-28'].slots.push({ at: 601, kind: 'side', status: 'pending',
    task: { title: 'R2', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side', rarity: 'common' },
    issuedAt: Date.now() - 5*60e3, deadline: Date.now() + 3600e3 });
  ev("completeTask('2026-10-28', 1, '')");
  A('未跨级不新增记录', S.rankUps.length === n1, `${n1}->${S.rankUps.length}`);
}

/* ── 19. 周报：结构化指标 + AI 失败降级 ── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T22:00:00').getTime() });
  const S = ev('S');
  // 造一周数据：昨天 2 done，今天 1 done + 1 expired
  const mk = (status, cat, title) => ({ at: 600, kind: 'side', status, settledAt: 1,
    task: { title, desc: '', category: cat, difficulty: 2, minutes: 30, kind: 'side', rarity: 'common' } });
  S.days['2026-10-27'] = { slots: [mk('done', '智力', 'A'), mk('done', '精神', 'B')] };
  S.days['2026-10-28'] = { slots: [mk('done', '智力', 'C'), mk('expired', '体质', 'D')] };

  const wm = ev('weekMetrics(S, "2026-10-28", 7)');
  A('周报指标：完成数正确', wm.cur.done === 3, JSON.stringify(wm.cur));
  A('周报指标：总数含失效', wm.cur.total === 4, `total=${wm.cur.total}`);
  A('周报指标：完成率 75%', wm.cur.rate === 75, wm.cur.rate);
  A('周报指标：有效行动天数 2', wm.cur.activeDays === 2, wm.cur.activeDays);
  A('周报指标：投入最多是智力', wm.strongest === '智力', wm.strongest);
  A('周报指标：统计区间正确', wm.range.from === '2026-10-22' && wm.range.to === '2026-10-28', JSON.stringify(wm.range));

  // AI 成功：返回 source=ai，正文来自 AI
  ev("chat = async () => '这是AI写的周报正文';");
  const okRes = await ev('callReport()');
  A('周报 AI 成功时 source=ai', okRes.source === 'ai' && okRes.text.includes('AI'), okRes.source);
  A('周报 AI 成功也带回指标', okRes.metrics && okRes.metrics.cur.done === 3);

  // AI 失败：必须降级，且不能抛异常
  ev("chat = async () => { throw new Error('网关超时'); };");
  let fellBack = null, threw = false;
  try { fellBack = await ev('callReport()'); } catch (e) { threw = true; }
  A('网关失败时周报不抛异常', threw === false);
  A('网关失败时降级本地生成', fellBack && fellBack.source === 'local', fellBack && fellBack.source);
  A('降级周报仍有正文', !!(fellBack && fellBack.text && fellBack.text.length > 30));
  A('降级周报含真实完成率', !!(fellBack && fellBack.text.includes('75%')), fellBack && fellBack.text.slice(0, 60));
}

/* ── 20. 周报建议能落地成任务池条目 ── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T22:00:00').getTime() });
  const S = ev('S');
  S.player.attrs = { 体质: 2, 智力: 60, 精神: 10, 自律: 10 };  // 体质最薄弱
  S.taskPool = [];
  const m = ev('weekMetrics(S, "2026-10-28", 7)');
  A('识别出最薄弱维度是体质', m.weakest === '体质', m.weakest);

  const sug = ev('suggestTasksFor(weekMetrics(S,"2026-10-28",7), FALLBACK_POOL, S.taskPool, 3)');
  A('能生成补强建议', sug.length === 3, sug.length);
  A('建议全部属于薄弱维度', sug.every(t => t.category === '体质'), JSON.stringify(sug.map(t => t.category)));
  A('建议不重复', new Set(sug.map(t => t.title)).size === sug.length);

  // 已在池中的不应重复添加
  S.taskPool = [{ title: sug[0].title, category: '体质', difficulty: 1, minutes: 10 }];
  const sug2 = ev('suggestTasksFor(weekMetrics(S,"2026-10-28",7), FALLBACK_POOL, S.taskPool, 3)');
  A('已在任务池的不再建议', !sug2.some(t => t.title === sug[0].title), JSON.stringify(sug2.map(t => t.title)));
}

/* ── 21. 任务池采用率：生成时打来源标记 ── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T10:30:00').getTime() });
  const S = ev('S');
  S.settings.dayStart = '09:00'; S.settings.dayEnd = '22:00';
  S.taskPool = [{ title: '拉伸10分钟', desc: '', category: '体质', difficulty: 1, minutes: 10 }];
  // 让 AI 返回一条与池内同名（轻微改写）的任务
  ev("callAI = async (n) => ([{title:'拉伸 10 分钟（重点肩颈）', desc:'', category:'体质', difficulty:1, minutes:10, kind:'side'}].slice(0,n));");
  await ev('settle()');
  const today = '2026-10-28';
  const slots = S.days[today].slots.filter(s => s.task);
  A('生成的任务被打上来源标记', slots.every(s => typeof s.task.fromPool === 'boolean'), JSON.stringify(slots.map(s => s.task.fromPool)));
  const poolOne = slots.find(s => s.task.title.includes('拉伸'));
  A('池内任务标记为 true', poolOne && poolOne.task.fromPool === true, poolOne && poolOne.task.fromPool);

  // 再来一条明确自拟的，验证 false 分支
  // 注意：此刻 10:30，旧槽位 at=600(10:00) 已过时；新槽位必须 <= 当前分钟才会被发布
  for (const s of S.days[today].slots) { if (s.status === 'waiting' || s.status === 'pending') s.status = 'expired'; }
  S.days[today].slots.push({ at: 615, kind: 'side', status: 'waiting' });
  ev("callAI = async (n) => ([{title:'AI自拟任务', desc:'', category:'智力', difficulty:2, minutes:30, kind:'side'}].slice(0,n));");
  await ev('settle()');
  const aiOne = S.days[today].slots.find(s => s.task && s.task.title === 'AI自拟任务');
  A('AI 自拟任务标记为 false', aiOne && aiOne.task.fromPool === false, aiOne && aiOne.task.fromPool);

  const st = ev('poolStats(S)');
  A('统计里池采用数 >= 1', st.fromPoolIssued >= 1, st.fromPoolIssued);
  A('统计采用率在 0~100', st.adoptionRate >= 0 && st.adoptionRate <= 100, st.adoptionRate);
  A('该池任务被记为已采用', st.perTask.some(t => t.title === '拉伸10分钟' && t.issued >= 1), JSON.stringify(st.perTask));
}

/* ── 22. 错过提醒的补救：离线期到点的任务按"看到的那一刻"重新计时 ── */
{
  const nowMs = new Date('2026-10-28T15:00:00').getTime();
  const { ev, toasts } = makeSandbox({ now: () => nowMs });
  const S = ev('S');
  S.created = 1792999742652;
  S.settings.dayStart = '09:00'; S.settings.dayEnd = '22:00';
  const today = '2026-10-28';
  // 面板 3 小时没心跳（关机/睡眠），期间 10:00 的支线与 11:00 的突发都到点了
  ev(`markSeen(${nowMs - 3 * 3600e3})`);
  S.days[today] = { tzOffset: -(new Date(nowMs).getTimezoneOffset()),
    slots: [{ at: 600, kind: 'side', status: 'waiting', task: null, issuedAt: 0, deadline: 0 },
            { at: 660, kind: 'burst', status: 'waiting', task: null, issuedAt: 0, deadline: 0 }] };
  ev("callAI = async (n) => ([{title:'补时任务',desc:'',category:'智力',difficulty:2,minutes:30,kind:'side'}].slice(0,n));");
  await ev('settle()');
  const side = S.days[today].slots.find(s => s.at === 600);
  const burst = S.days[today].slots.find(s => s.at === 660);
  A('离线错过的支线仍会发布', side.status === 'pending', side.status);
  A('支线截止按此刻重算（6 小时）', side.deadline === nowMs + 360 * 60e3, new Date(side.deadline).toTimeString().slice(0, 5));
  A('支线打了补救标记', side.rescued === 'side', side.rescued);
  A('离线超窗突发被救回而非收回', burst.status === 'pending', burst.status);
  A('救回后给足 2 小时', burst.deadline === nowMs + 120 * 60e3, new Date(burst.deadline).toTimeString().slice(0, 5));
  A('救回标记为 burst', burst.rescued === 'burst', burst.rescued);
  A('当天记录了补救摘要', S.days[today].rescue && S.days[today].rescue.n === 2, JSON.stringify(S.days[today].rescue));
  A('补救有 toast 提示', toasts.some(t => String(t.t).includes('补救')), toasts.map(t => t.t).slice(0, 3));
  A('救回消耗当日额度', S.days[today].rescueCount === 1, S.days[today].rescueCount);
}

/* ── 23. 在线时错过不享受补救：突发照旧收回，支线不额外延长 ── */{
  const nowMs = new Date('2026-10-28T15:00:00').getTime();
  const { ev } = makeSandbox({ now: () => nowMs });
  const S = ev('S');
  S.created = 1792999742652;
  S.settings.dayStart = '09:00'; S.settings.dayEnd = '22:00';
  const today = '2026-10-28';
  ev(`markSeen(${nowMs - 60e3})`);      // 1 分钟前刚有心跳 → 一直在
  S.days[today] = { tzOffset: -(new Date(nowMs).getTimezoneOffset()),
    slots: [{ at: 600, kind: 'side', status: 'waiting' },
            { at: 660, kind: 'burst', status: 'waiting' }] };
  ev("callAI = async (n) => ([{title:'在线任务',desc:'',category:'智力',difficulty:2,minutes:30,kind:'side'}].slice(0,n));");
  await ev('settle()');
  const side = S.days[today].slots.find(s => s.at === 600);
  const burst = S.days[today].slots.find(s => s.at === 660);
  A('在线的支线按发布时刻算截止', side.deadline === new Date('2026-10-28T16:00:00').getTime(), new Date(side.deadline).toTimeString().slice(0, 5));
  A('在线的支线不标补救', !side.rescued, side.rescued);
  A('在线拖过 2 小时的突发仍被收回', burst.status === 'void', burst.status);
  A('收回原因记为忽略', burst.voidReason === 'ignored', burst.voidReason);
  A('没有补救摘要', !S.days[today].rescue, JSON.stringify(S.days[today].rescue));
}

/* ── 23b. 后台标签 / 最小化窗口不算"看着面板" ── */
{
  const nowMs = new Date('2026-10-28T15:00:00').getTime();
  const { ctx, ev } = makeSandbox({ now: () => nowMs });
  const S = ev('S');
  S.created = 1792999742652;
  S.settings.dayStart = '09:00'; S.settings.dayEnd = '22:00';
  const today = '2026-10-28';
  ctx.document.visibilityState = 'hidden';
  ev(`markSeen(${nowMs - 2 * 3600e3})`);
  S.days[today] = { tzOffset: -(new Date(nowMs).getTimezoneOffset()),
    slots: [{ at: 600, kind: 'side', status: 'waiting' }] };
  ev("callAI = async (n) => ([{title:'后台任务',desc:'',category:'智力',difficulty:2,minutes:30,kind:'side'}].slice(0,n));");
  await ev('settle()');
  const side = S.days[today].slots[0];
  A('后台标签按离线补救', side.rescued === 'side', side.rescued);
  A('不可见时不刷新心跳', ev('lastSeenAt()') === nowMs - 2 * 3600e3, ev('lastSeenAt()'));
}

/* ── 24. 补救在界面上可见：顶部说明 + 卡片徽标 ── */
{
  const nowMs = new Date('2026-10-28T15:00:00').getTime();
  const { ev, els } = makeSandbox({ now: () => nowMs });
  const S = ev('S');
  const today = '2026-10-28';
  S.days[today] = { rescue: { at: nowMs, n: 2, gapMin: 180, side: 1, burst: 1 },
    slots: [
      { at: 600, kind: 'side', status: 'pending', rescued: 'side',
        task: { title: '补时任务', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side' },
        issuedAt: nowMs - 5*60e3, deadline: nowMs + 3600e3 },
      { at: 660, kind: 'burst', status: 'pending', rescued: 'burst',
        task: { title: '救回任务', desc: '', category: '体质', difficulty: 2, minutes: 20, kind: 'burst' },
        issuedAt: nowMs - 5*60e3, deadline: nowMs + 3600e3 },
      { at: 700, kind: 'burst', status: 'void', voidReason: 'budget' },
    ] };
  ev('renderTasks()');
  const html = els.get('taskList').innerHTML;
  A('界面有补救说明', html.includes('rescue-note') && html.includes('3.0 小时'), html.slice(0, 120));
  A('说明里分别标注支线与突发', html.includes('支线的截止按此刻重新计时') && html.includes('突发任务已救回'));
  A('支线卡片带「重新计时」徽标', html.includes('重新计时'));
  A('突发卡片带「错过救回」徽标', html.includes('错过救回'));
  A('额度用完的收回卡说明原因', html.includes('补救额度（1 次）已用尽'));
}

/* ── 25. 离线期间到期的今日任务：给补交窗口，而不是回来就发现已失效 ── */
{
  const nowMs = new Date('2026-10-28T17:00:00').getTime();
  const { ev, toasts } = makeSandbox({ now: () => nowMs });
  const S = ev('S');
  S.created = 1792999742652;
  S.settings.dayStart = '09:00'; S.settings.dayEnd = '22:00';
  const today = '2026-10-28';
  ev(`markSeen(${nowMs - 3 * 3600e3})`);  // 14:00 离开，17:00 回来
  const expired = S.stats.expired;
  S.days[today] = { tzOffset: -(new Date(nowMs).getTimezoneOffset()),
    slots: [
      // 16:00 到期：宿主 14:00 离开时它还活着 → 该补交
      { at: 600, kind: 'side', status: 'pending',
        task: { title: '离线期间到期', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side' },
        issuedAt: nowMs - 6 * 3600e3, deadline: nowMs - 3600e3 },
      // 13:00 到期：宿主 14:00 离开前就已经超时（当时在线没做）→ 照旧失效
      { at: 700, kind: 'side', status: 'pending',
        task: { title: '离开前就超时', desc: '', category: '自律', difficulty: 2, minutes: 30, kind: 'side' },
        issuedAt: nowMs - 8 * 3600e3, deadline: nowMs - 4 * 3600e3 },
    ] };
  await ev('settle()');
  const away = S.days[today].slots[0], before = S.days[today].slots[1];
  A('离线期间到期的任务不注销', away.status === 'pending', away.status);
  A('补交窗口 = 现在起 2 小时', away.deadline === nowMs + 2 * 3600e3, new Date(away.deadline).toTimeString().slice(0, 5));
  A('标记为补交窗口', away.rescued === 'grace', away.rescued);
  A('离开前就超时的任务照旧失效', before.status === 'expired', before.status);
  A('失效计数只加一条', S.stats.expired === expired + 1, `${expired} -> ${S.stats.expired}`);
  A('补救摘要记了 grace', S.days[today].rescue && S.days[today].rescue.grace === 1, JSON.stringify(S.days[today].rescue));
  A('补交窗口有 toast/公告', toasts.some(t => String(t.t).includes('补交窗口')) || S.log.some(l => l.txt.includes('补交窗口')));

  // 再跑一轮：窗口内不再重复延长
  const dl = S.days[today].slots[0].deadline;
  await ev('settle()');
  A('补交窗口不重复延长', S.days[today].slots[0].deadline === dl);
}

/* ── 22. 夜间突发的截止不得跨天（否则变成挂在昨天记录里的幽灵任务）── */
{
  // 23:05 打开面板，23:00 触发的突发任务到点待发布
  const lateNight = new Date('2026-10-28T23:05:00').getTime();
  const { ev } = makeSandbox({ now: () => lateNight });
  const S = ev('S');
  S.settings.dayStart = '09:00'; S.settings.dayEnd = '23:00';
  const today = '2026-10-28';
  S.days[today] = { slots: [{ at: 23 * 60, kind: 'burst', status: 'waiting' }] };
  ev("callAI = async (n) => ([{title:'夜间突发', desc:'', category:'智力', difficulty:2, minutes:20, kind:'burst'}].slice(0,n));");
  await ev('settle()');
  const sl = S.days[today].slots.find(s => s.task && s.task.title === '夜间突发');
  A('夜间突发被正常发布', !!sl, JSON.stringify(S.days[today].slots.map(s => s.status)));
  if (sl) {
    const dayEnd = new Date(today + 'T23:59:00').getTime();
    A('夜间突发截止不越过当日末', sl.deadline <= dayEnd, new Date(sl.deadline).toLocaleString('zh-CN'));
    A('夜间突发截止仍在当日', new Date(sl.deadline).getDate() === 28, new Date(sl.deadline).toISOString());
  }
}

/* ── 23. 救回额度透明化：额度状态在 UI 常驻可见，而不是用光才知道 ── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T10:30:00').getTime() });
  const S = ev('S');
  const today = '2026-10-28';
  // 今天含一个突发槽位 → 应显示额度条
  S.days[today] = { slots: [
    { at: 600, kind: 'burst', status: 'pending', task: { title: 'B', desc: '', category: '智力', difficulty: 2, minutes: 20, kind: 'burst' }, deadline: Date.now() + 3600e3 },
    { at: 610, kind: 'side', status: 'pending', task: { title: 'S', desc: '', category: '自律', difficulty: 1, minutes: 10, kind: 'side' }, deadline: Date.now() + 3600e3 },
  ] };
  ev("renderTasks()");
  const box1 = ev("document.getElementById('taskList').innerHTML");
  A('有突发任务时显示额度条', box1.includes('救回额度'), box1.slice(0, 80));
  A('额度显示为满额', box1.includes(`1/1`), box1.slice(0, 120));

  // 用掉额度后：显示 0/1 且提示已用完
  S.days[today].rescueCount = 1;
  ev("renderTasks()");
  const box2 = ev("document.getElementById('taskList').innerHTML");
  A('额度用掉后显示 0/1', box2.includes('0/1'), box2.slice(0, 120));
  A('额度耗尽有明确提示', box2.includes('已用完'), box2.slice(0, 160));

  // 没有突发任务的某天且没用过额度 → 不显示（避免噪音）
  S.days[today] = { slots: [
    { at: 600, kind: 'side', status: 'pending', task: { title: 'S', desc: '', category: '自律', difficulty: 1, minutes: 10, kind: 'side' }, deadline: Date.now() + 3600e3 },
  ] };
  ev("renderTasks()");
  const box3 = ev("document.getElementById('taskList').innerHTML");
  A('无突发且未用额度时不显示额度条', !box3.includes('救回额度'), box3.slice(0, 80));
}

/* ── 24. 周报补救复盘：把「错过几次」变成可读结论 ── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T22:00:00').getTime() });
  const S = ev('S');
  S.player.attrs = { 体质: 5, 智力: 50, 精神: 5, 自律: 5 };
  S.days = {
    '2026-10-27': { slots: [{ status: 'done', task: { title: 'A', category: '智力' } }],
      rescue: { at: 1, n: 2, side: 1, burst: 1, grace: 0, gapMin: 95 }, rescueCount: 1 },
    '2026-10-28': { slots: [{ status: 'done', task: { title: 'B', category: '智力' } }],
      rescue: { at: 1, n: 1, side: 0, burst: 0, grace: 1, gapMin: 40 }, rescueCount: 0 },
  };
  const m = ev('weekMetrics(S, "2026-10-28", 7)');
  A('周报汇总错过总次数', m.cur.rescue.events === 3, m.cur.rescue.events);
  A('周报区分三种补救', m.cur.rescue.side === 1 && m.cur.rescue.burst === 1 && m.cur.rescue.grace === 1,
    JSON.stringify(m.cur.rescue));
  A('周报统计额度用光天数', m.cur.rescue.quotaDays === 1, m.cur.rescue.quotaDays);
  A('周报给出补救结论', !!m.rescueInsight && !!m.rescueInsight.text, m.rescueInsight && m.rescueInsight.level);
  A('有错过时结论不是 ok', m.rescueInsight.level !== 'ok', m.rescueInsight.level);
  A('本地周报包含补救复盘', ev('localReport(weekMetrics(S,"2026-10-28",7))').includes('补救复盘'));
  A('周报算出与上周的补救差', m.rescueDelta === 3, m.rescueDelta);

  // 完全没错过 → ok 级结论
  S.days = { '2026-10-28': { slots: [{ status: 'done', task: { title: 'C', category: '智力' } }] } };
  const m2 = ev('weekMetrics(S, "2026-10-28", 7)');
  A('没错过时结论为 ok', m2.rescueInsight.level === 'ok', m2.rescueInsight.level);
  A('没错过时统计为 0', m2.cur.rescue.events === 0);
}

/* ── 25. 作息诊断 → 一键调活跃窗口 ── */
{
  const { ev } = makeSandbox({ now: () => new Date('2026-10-28T23:30:00').getTime() });
  const S = ev('S');
  S.settings.dayStart = '09:00'; S.settings.dayEnd = '22:00';
  // 全部在晚上完成 → 建议窗口应落在晚间
  const at = t => new Date('2026-10-28T' + t + ':00').getTime();
  S.days = { '2026-10-28': { slots: [
    { status: 'done', settledAt: at('19:30'), task: { title: 'A', category: '智力' } },
    { status: 'done', settledAt: at('20:00'), task: { title: 'B', category: '智力' } },
    { status: 'done', settledAt: at('21:15'), task: { title: 'C', category: '智力' } },
  ] } };
  const m = ev('weekMetrics(S, "2026-10-28", 7)');
  A('周报带窗口建议', !!m.windowSuggestion, JSON.stringify(m.windowSuggestion));
  A('建议窗口落在晚间', m.windowSuggestion.start >= '18:00', m.windowSuggestion.start);
  A('建议与当前设置不同', m.windowSuggestion.changed === true);

  // 点击按钮应真的改设置（runAction 是具名函数，可直接在沙箱里调用）
  ev("S.lastReport={t:Date.now(), text:'x', metrics:weekMetrics(S,'2026-10-28',7), source:'ai'};");
  const before = { s: S.settings.dayStart, e: S.settings.dayEnd };
  await ev("runAction('applyWindow', {dataset:{act:'applyWindow'}}, null)");
  A('点击后活跃窗口被更新', S.settings.dayStart !== before.s || S.settings.dayEnd !== before.e,
    `${before.s}-${before.e} -> ${S.settings.dayStart}-${S.settings.dayEnd}`);
  A('新窗口等于建议值', S.settings.dayStart === m.windowSuggestion.start
    && S.settings.dayEnd === m.windowSuggestion.end,
    `${S.settings.dayStart}-${S.settings.dayEnd}`);
  A('调整写入系统公告', S.log.some(l => l.txt.includes('活跃窗口')), S.log[0] && S.log[0].txt);
  A('公告记录了旧值与新值', S.log.some(l => l.txt.includes(before.s) && l.txt.includes(m.windowSuggestion.start)));

  // 再点一次：已一致，不应重复写公告
  const logLen = S.log.length;
  await ev("runAction('applyWindow', {dataset:{act:'applyWindow'}}, null)");
  A('已一致时不重复调整', S.log.length === logLen, `${logLen} -> ${S.log.length}`);
}

/* ── 26. 新任务完成冷却：刚发布的任务不能立刻打卡（防误点） ── */
{
  const nowMs = new Date('2026-10-28T10:30:00').getTime();
  const { ev, toasts } = makeSandbox({ now: () => nowMs });
  const S = ev('S');
  S.days['2026-10-28'] = { slots: [{ at: 600, kind: 'side', status: 'pending',
    task: { title: '刚发布', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side' },
    issuedAt: nowMs - 3000, deadline: nowMs + 3600e3 }] };
  const c0 = S.player.coins;
  ev("completeTask('2026-10-28', 0, '')");
  A('刚发布 3 秒的任务被冷却拦下', S.days['2026-10-28'].slots[0].status === 'pending');
  A('冷却期间不发奖励', S.player.coins === c0);
  A('冷却给出提示', toasts.some(t => t.t.includes('刚发布')), toasts.map(t => t.t).join('|'));
  // 冷却过去后可以正常完成
  ev(`S.days['2026-10-28'].slots[0].issuedAt = ${nowMs - 61 * 1000}`);
  ev("completeTask('2026-10-28', 0, '')");
  A('冷却结束后可以完成', S.days['2026-10-28'].slots[0].status === 'done');
}

/* ── 27. 完成可撤销：快照回滚奖励、进度与连锁 ── */
{
  const nowMs = new Date('2026-10-28T10:30:00').getTime();
  const { ev } = makeSandbox({ now: () => nowMs });
  const S = ev('S');
  ev("BLESSINGS.length=0; BLESSINGS.push({id:'none',name:'无',desc:'',mult:{}});");
  S.days['2026-10-28'] = { slots: [{ at: 600, kind: 'side', status: 'pending',
    task: { title: '可撤销', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side' },
    issuedAt: nowMs - 10 * 60e3, deadline: nowMs + 3600e3 }] };
  const before = { coins: S.player.coins, exp: S.player.exp, done: S.stats.done, slots: S.days['2026-10-28'].slots.length };
  ev("completeTask('2026-10-28', 0, '')");
  A('完成后奖励已发放', S.player.coins > before.coins);
  ev('undoComplete()');
  A('撤销后金币回到完成前', S.player.coins === before.coins, `${before.coins} -> ${S.player.coins}`);
  A('撤销后 EXP 回到完成前', S.player.exp === before.exp);
  A('撤销后完成计数回到完成前', S.stats.done === before.done);
  A('撤销后任务回到待完成', S.days['2026-10-28'].slots[0].status === 'pending');
  A('撤销后槽位数回到完成前', S.days['2026-10-28'].slots.length === before.slots);
  ev('undoComplete()');
  A('没有快照时撤销只提示不报错', S.player.coins === before.coins);
}

/* ── 28. 起步任务截止夹到当天结束（深夜窗口不产生跨午夜幽灵任务） ── */
{
  const nowMs = new Date('2026-10-28T22:30:00').getTime();
  const { ev } = makeSandbox({ now: () => nowMs });
  const S = ev('S');
  S.created = 1792999742652;
  S.settings.dayStart = '20:00'; S.settings.dayEnd = '23:59';
  S.days['2026-10-28'] = { tzOffset: -(new Date().getTimezoneOffset()),
    slots: [{ at: 1230, kind: 'side', status: 'expired', settledAt: 1,
      task: { title: '失效任务', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side' },
      issuedAt: nowMs - 9 * 3600e3, deadline: nowMs - 3600e3 }] };
  await ev('settle()');
  const starter = S.days['2026-10-28'].slots.find(s => s.starter);
  const dayEnd = new Date('2026-10-28T23:59:00').getTime();
  A('深夜窗口仍能补起步任务', !!starter);
  A('起步任务截止不跨午夜', !!starter && starter.deadline <= dayEnd, starter && new Date(starter.deadline).toISOString());
}

/* ── 29. AI 结果去重：重名丢弃，数量不足用近期没出现的模板补齐 ── */
{
  const nowMs = new Date('2026-10-28T10:30:00').getTime();
  const { ev } = makeSandbox({ now: () => nowMs });
  const S = ev('S');
  S.days['2026-10-26'] = { slots: [{ status: 'done', task: { title: '上周做过的' } }] };
  S.days['2026-10-28'] = { slots: [{ status: 'pending', task: { title: '今天待办' } }] };
  const out = ev(`(()=>{
    const hist = titleHistory(S.days, '2026-10-28');
    const arr = [
      {title:'今天待办', desc:'', category:'智力', difficulty:2, minutes:30, kind:'side'},
      {title:'新任务A', desc:'', category:'智力', difficulty:2, minutes:30, kind:'side'},
      {title:'新任务A', desc:'', category:'智力', difficulty:2, minutes:30, kind:'side'},
    ];
    return dedupeTasks(arr, 2, ['side','side'], hist, new Set(['今天待办']));
  })()`);
  const titles = out.map(t => t.title);
  A('AI 结果不含今天已有的任务', !titles.includes('今天待办'), titles.join('/'));
  A('AI 结果批内不重名', new Set(titles).size === titles.length, titles.join('/'));
  A('AI 结果不足时补齐到 n', out.length === 2, String(out.length));
}

/* ── 30. 兜底任务与起步/连锁共用避让规则 ── */
{
  const nowMs = new Date('2026-10-28T10:30:00').getTime();
  const { ev } = makeSandbox({ now: () => nowMs });
  const S = ev('S');
  const recentTitles = ev("FALLBACK_POOL.slice(0,10).map(t=>t.title)");
  S.days['2026-10-27'] = { slots: recentTitles.map(t => ({ status: 'done', task: { title: t } })) };
  const out = ev("fallbackTasks(2, ['side','side'])");
  A('兜底任务避开近 7 天出现过的', out.every(t => !recentTitles.includes(t.title)), out.map(t => t.title).join('/'));
  A('兜底任务数量正确', out.length === 2);
}

/* ── 31. 今日页已完成折叠 ── */
{
  const nowMs = new Date('2026-10-28T10:30:00').getTime();
  const { ev, els } = makeSandbox({ now: () => nowMs });
  const S = ev('S');
  S.days['2026-10-28'] = { slots: [
    { at: 600, kind: 'side', status: 'done', task: { title: '已完成甲', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side' }, issuedAt: nowMs - 3600e3, deadline: nowMs + 3600e3 },
    { at: 700, kind: 'side', status: 'pending', task: { title: '待办乙', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side' }, issuedAt: nowMs - 3600e3, deadline: nowMs + 3600e3 },
  ] };
  ev('renderTasks()');
  let html = els.get('taskList').innerHTML;
  A('待办始终显示', html.includes('待办乙'));
  A('已完成默认折叠', !html.includes('已完成甲') && html.includes('done-toggle'), html.slice(0, 80));
  await ev("runAction('toggleDone', {dataset:{act:'toggleDone'}}, null)");
  html = els.get('taskList').innerHTML;
  A('点开后可看到已完成', html.includes('已完成甲'));
}

/* ── 32. 冷却中的「完成」按钮渲染为不可点，冷却结束后恢复 ── */
{
  const nowMs = new Date('2026-10-28T10:30:00').getTime();
  const { ev, els } = makeSandbox({ now: () => nowMs });
  const S = ev('S');
  S.days['2026-10-28'] = { slots: [{ at: 600, kind: 'side', status: 'pending',
    task: { title: '刚发布的任务', desc: '', category: '智力', difficulty: 2, minutes: 30, kind: 'side' },
    issuedAt: nowMs - 5e3, deadline: nowMs + 3600e3 }] };
  ev('renderTasks()');
  const html = els.get('taskList').innerHTML;
  A('冷却中按钮不可点', html.includes('disabled') && !html.includes('data-act="done"'), html.match(/<button[^>]*>/g)?.join(' ') || '');
  A('冷却中显示剩余秒数', /完成（\d+s）/.test(html), html.match(/完成（\d+s）/)?.[0]);
  // 冷却结束后（模拟 issuedAt 提前）按钮恢复可点
  ev(`S.days['2026-10-28'].slots[0].issuedAt = ${nowMs - 120e3}`);
  ev('renderTasks()');
  A('冷却结束后按钮可点', els.get('taskList').innerHTML.includes('data-act="done"'));
}

console.log(fails ? `\n${fails} 项失败 ✗` : '\n引擎冒烟测试全部通过 ✓');
process.exit(fails ? 1 : 0);
