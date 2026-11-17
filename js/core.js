'use strict';
/* core.js — 纯函数核心：工具、确定性随机、计划/奖励/等级公式、数据统计、自检。
   不依赖 DOM 与存档状态，是 selftest 的覆盖对象。 */

/* ── 工具 ── */
const pad = n => String(n).padStart(2,'0');
const ds = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const nowMin = () => { const d=new Date(); return d.getHours()*60+d.getMinutes(); };
const esc = s => String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hm = m => `${pad(Math.floor(m/60))}:${pad(m%60)}`;
const CATS = ['体质','智力','精神','自律'];
const NORMAL_ATTR = 100; // 常人均值基准（每维），属性对比用

/* ── 确定性随机（任务发布时刻的核心）── */
function strHash(s){ let h=2166136261; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619);} return h>>>0; }
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
const rngFor = s => mulberry32(strHash(s));

/* ── 计划 / 奖励 / 等级 ── */
function planDay(dayStr, salt, win){
  const r = rngFor(dayStr+'|'+salt);
  const [sh,sm]=win.start.split(':').map(Number), [eh,em]=win.end.split(':').map(Number);
  const from=sh*60+sm, to=Math.max(eh*60+em, from+60);
  const count = 2 + (r()<0.45?1:0);
  const slots=[];
  for(let i=0;i<count;i++) slots.push({ at: from+Math.floor(r()*(to-from)), kind: r()<0.32?'burst':'side' });
  slots.sort((a,b)=>a.at-b.at);
  return slots;
}
function rewards(t){
  const d = Math.min(3, Math.max(1, t.difficulty|0||1));
  const mult = t.kind==='burst'?2:1;
  return { exp: d*15*mult, coins: d*8*mult, attr: d*4*mult };
}

/* ── 结算链：唯一奖励出口（唯一路径约束）──
   任何地方要算"这条任务给多少"，都必须走 settleReward()，不允许自己乘系数。
   背景：此前 rewards / rewardsWithRarity / halfRewards / blessing 分散在多处，
   任务卡按 rewardsWithRarity 显示、实际发放又叠赐福 —— 卡上写 EXP+15，
   到账 EXP+22，用户看到的是对不上账。收成一个入口后，展示和发放同源。

   顺序固定，五步：
     ① 基础（难度 × 类型倍率）
     ② 稀有度
     ③ 分段推进（半奖：不吃稀有度与赐福，保持原行为）
     ④ 当日赐福
     ⑤ 连胜护盾 / 低谷庇护等后续机制在这里挂，不许绕到别处
   返回 { exp, coins, attr, factors }，factors 用于向用户解释"为什么是这个数"。 */
function settleReward(t, opt){
  const o = opt || {};
  const partial = !!o.partial;
  const factors = {};
  // ③ 半奖走原路径：只给基础的一半，不叠稀有度与赐福
  if(partial){
    const half = halfRewards(t);
    factors.partial = true;
    return { exp: half.exp, coins: half.coins, attr: half.attr, factors };
  }
  const base = rewards(t);
  const rr = RARITY[t && t.rarity] || RARITY.common;
  const bless = (typeof o.blessing==='number' && o.blessing>0) ? o.blessing : 1;
  factors.rarity = rr.exp;
  factors.blessing = bless;
  return {
    exp:  Math.round(base.exp  * rr.exp * bless),
    coins:Math.round(base.coins* rr.coins * bless),
    attr: Math.round(base.attr * rr.attr * bless),
    factors,
  };
}
const expToNext = lv => 60 + lv*40;
/* 属性等级阈值：从高到低排列，供 attrRank 与跨级播报共用（避免两处各写一套数字） */
const RANK_LADDER = [
  { rank:'S', min:600, name:'超凡' },
  { rank:'A', min:400, name:'卓越' },
  { rank:'B', min:260, name:'精通' },
  { rank:'C', min:160, name:'熟练' },
  { rank:'D', min:90,  name:'入门' },
  { rank:'E', min:40,  name:'初显' },
  { rank:'F', min:0,   name:'未觉醒' },
];
function attrRank(v){
  for(const l of RANK_LADDER) if(v>=l.min) return l.rank;
  return 'F';
}
function rankInfo(v){
  for(const l of RANK_LADDER) if(v>=l.min) return l;
  return RANK_LADDER[RANK_LADDER.length-1];
}
/* 跨级检测：属性从 before 增到 after 时若跨过等级线，返回新等级信息 */
function rankUpgrade(before, after){
  const a=rankInfo(before), b=rankInfo(after);
  if(a.rank===b.rank) return null;
  return b;
}
/* 距下一级还差多少（已满级返回 null） */
function nextRankGap(v){
  const cur=rankInfo(v), idx=RANK_LADDER.findIndex(l=>l.rank===cur.rank);
  const next = idx>0 ? RANK_LADDER[idx-1] : null;
  if(!next) return null;
  return { next, need: next.min - v };
}
/* 支线截止 = min(当日末, 发布时刻 + 6 小时)：避免 23:50 发布的任务 9 分钟后失效 */
const SIDE_TTL_MIN = 6*60;
function computeDeadline(kind, atMin, dayStr){
  const day0 = new Date(dayStr+'T00:00:00').getTime();
  if(kind==='burst') return day0 + (atMin+120)*60000;
  return Math.min(day0 + (23*60+59)*60000, day0 + (atMin+SIDE_TTL_MIN)*60000);
}

/* ── 数据统计（数据页用）── */
function dayStats(days, dateStr){
  const d = days[dateStr];
  const s = { done:0, total:0, expired:0, void:0 };
  if(!d) return s;
  for(const sl of d.slots){
    if(sl.status==='waiting') continue;
    s.total++;
    if(sl.status==='done') s.done++;
    else if(sl.status==='expired') s.expired++;
    else if(sl.status==='void') s.void++;
  }
  return s;
}
function computeStreak(days, todayStr, shielded){
  // 今天已完成则从今天起算；今天尚未完成不打断连续（截至昨天）
  // shielded：被护盾救下的日期集合，这些日子当作"没断"处理
  const sh = shielded instanceof Set ? shielded : new Set(shielded||[]);
  let n=0, d=new Date(todayStr+'T00:00:00');
  if(dayStats(days, todayStr).done>0) n++;
  while(n<3650){
    d.setDate(d.getDate()-1);
    const k=ds(d);
    if(dayStats(days, k).done>0 || sh.has(k)) n++;
    else break;
  }
  return n;
}

/* ── 连胜护盾（移植自「海克斯学习平台」guardrail 的 onMiss）──
   断签不该直接清零：真实生活里一天没做，往往不是放弃，是那天被别的事占满了。
   规则：连续天数每满 7 天，发 1 枚护盾（最多存 3 枚）；
        断签时自动消耗 1 枚，那天记为"护住"，连续天数不清零。
   与海克斯的差异：海克斯是"连胜减半"，这里保留连续天数更符合个人成长场景
        ——惩罚感更低，机制也更好解释。 */
const SHIELD_MAX = 3;
const SHIELD_EARN_EVERY = 7;

/* 护盾账本：已发放（累计、单调递增）− 已消耗 = 剩余。
   用"累计发放"而不是"当前 streak / 7"：断签后 streak 归零，
   后者会把已经到手的护盾算回去。 */
function shieldLedger(granted, used){
  const g = Math.max(0, granted|0), u = Math.max(0, used|0);
  return { granted: g, used: u, left: Math.max(0, Math.min(SHIELD_MAX, g - u)) };
}
/* 这次 streak 是否够再发一枚（每满 7 天发一枚，累计不超过上限的倍数） */
function shieldShouldGrant(streak, granted){
  const should = Math.min(SHIELD_MAX, Math.floor(Math.max(0,streak) / SHIELD_EARN_EVERY));
  return (granted|0) < should;
}
/* 取当前存档的连胜（自动带上护盾救下的日子） */
function streakOf(S){
  return computeStreak(S.days, ds(new Date()), S.shieldedDays);
}

/* ── 分段推进：把「45 分钟」拆成「先做 10 分钟」──
   部分完成给一半奖励并进入 partial 状态，剩余一次完成时补发另一半。
   只对够长的任务开放（太短的任务拆开没有意义）。 */
const PARTIAL_MIN_MINUTES = 20;
const canSplit = t => !!t && (t.minutes|0) >= PARTIAL_MIN_MINUTES && t.difficulty >= 2;
function halfRewards(t){
  const r = rewards(t);
  return { exp: Math.floor(r.exp/2), coins: Math.floor(r.coins/2), attr: Math.floor(r.attr/2) };
}

/* ── 成就：纯函数，输入存档返回本次新解锁的 id 列表 ──
   用持久化的 S.achievements 做去重，所以可以反复调用。 */
const ACHIEVEMENTS = [
  { id:'first',    name:'初次觉醒',   desc:'完成第一个任务',            test:S=>S.stats.done>=1 },
  { id:'ten',      name:'步入正轨',   desc:'累计完成 10 个任务',        test:S=>S.stats.done>=10 },
  { id:'fifty',    name:'习惯成形',   desc:'累计完成 50 个任务',        test:S=>S.stats.done>=50 },
  { id:'streak3',  name:'三日之约',   desc:'连续 3 天有完成',           test:S=>computeStreak(S.days,ds(new Date()))>=3 },
  { id:'streak7',  name:'一周不辍',   desc:'连续 7 天有完成',           test:S=>computeStreak(S.days,ds(new Date()))>=7 },
  { id:'streak30', name:'铁律宿主',   desc:'连续 30 天有完成',          test:S=>computeStreak(S.days,ds(new Date()))>=30 },
  { id:'level5',   name:'Lv.5',      desc:'等级达到 5',               test:S=>S.player.level>=5 },
  { id:'level10',  name:'Lv.10',     desc:'等级达到 10',              test:S=>S.player.level>=10 },
  { id:'d_rank',   name:'超越常人',   desc:'任一属性达到 D 级（90）',    test:S=>CATS.some(c=>(S.player.attrs[c]||0)>=90) },
  { id:'c_rank',   name:'小有所成',   desc:'任一属性达到 C 级（160）',   test:S=>CATS.some(c=>(S.player.attrs[c]||0)>=160) },
  { id:'balanced', name:'四维均衡',   desc:'四维全部 ≥ 40（E 级）',      test:S=>CATS.every(c=>(S.player.attrs[c]||0)>=40) },
  { id:'burst',    name:'抓住机会',   desc:'完成一个突发限时任务',        test:S=>Object.values(S.days).some(d=>d.slots.some(sl=>sl.status==='done'&&sl.kind==='burst')) },
  { id:'perfect',  name:'今日全清',   desc:'某天完成的已发布任务全清',     test:S=>Object.keys(S.days).some(k=>{ const s=dayStats(S.days,k); return s.total>0&&s.done===s.total; }) },
  { id:'rich',     name:'小金库',     desc:'累计持有过 500 金币',         test:S=>(S.player.coins||0)>=500 },
];
function checkAchievements(S){
  const got = new Set(S.achievements || []);
  const fresh = [];
  for(const a of ACHIEVEMENTS){
    if(got.has(a.id)) continue;
    let ok=false;
    try{ ok = !!a.test(S); }catch(e){ ok=false; }
    if(ok) fresh.push(a.id);
  }
  return fresh;
}

/* ── 商城攒钱进度：还差多少金币 / 相当于几个中等任务 ── */
function shopProgress(coins, cost){
  const cost_ = Math.max(1, cost|0), coins_ = Math.max(0, coins|0);
  const pct = Math.min(100, Math.round(coins_/cost_*100));
  const need = Math.max(0, cost_-coins_);
  const perTask = rewards({difficulty:2, kind:'side'}).coins;  // 一个 ★★ 支线 = 16 金币
  return { pct, need, tasks: Math.ceil(need/perTask) };
}

/* ── 低谷庇护（移植自「海克斯学习平台」guardrail 的 troughCheck）──
   连续 N 天零完成 → 进入"低谷"。此时系统主动降档，而不是继续加压：
     · 不再追加起步任务 / 连锁任务（少即是多）
     · 当天任务数上限降到 1~2，难度压到 ★1（先恢复节奏，不是冲刺）
     · 公告语气转为"先做一件小事"，不说教
   触发条件只看"连续零完成天数"，不看完成率——完成率波动是常态，
   连续归零才是真的卡住了。 */
const TROUGH_DAYS = 2;   // 连续几天零完成算进入低谷

/* 从 endDay 的「前一天」往前数，连续零完成的天数。
   为什么不从 endDay 当天算：当天还没过完，早上打开面板时今天必然 0 完成，
   把它算进去会让所有人一睁眼就进低谷。只看已经完结的日子才算数。
   跳过没有记录的日子：系统没运行的那天不算宿主偷懒。 */
function troughDepth(days, endDay){
  let n = 0, d = new Date(endDay+'T00:00:00');
  d.setDate(d.getDate()-1);                            // 从昨天起算
  for(let i=0; i<30; i++){
    const k = ds(d);
    const rec = days[k];
    if(!rec){ d.setDate(d.getDate()-1); continue; }    // 没记录：跳过，不惩罚
    const st = dayStats(days, k);
    if(st.total === 0){ d.setDate(d.getDate()-1); continue; }
    if(st.done > 0) break;                             // 有完成 → 低谷结束
    n++;
    d.setDate(d.getDate()-1);
  }
  return n;
}
function inTrough(days, endDay){
  return troughDepth(days, endDay) >= TROUGH_DAYS;
}

/* ── 补交拉力：窗口过半仍零完成时，给一个 10 分钟起步任务 ──
   只判断"该不该给"，具体任务由 ai.js 的 FALLBACK_POOL 提供，保持 core 纯函数。 */
function needsStarterTask(day, nowMinVal, win){
  if(!day || !day.slots || !day.slots.length) return false;
  const [sh,sm]=win.start.split(':').map(Number), [eh,em]=win.end.split(':').map(Number);
  const from=sh*60+sm, to=eh*60+em;
  if(nowMinVal < from + (to-from)*0.6) return false;               // 还没过 60%
  const live = day.slots.filter(s=>s.status!=='waiting' && s.status!=='void');
  if(live.length === 0) return false;
  if(live.some(s=>s.status==='done' || s.status==='partial')) return false;  // 已有进展就不催
  return !day.slots.some(s=>s.starter) && !day.starter;                      // 一天只给一次
}

/* ── 错过提醒的补救 ──
   提醒是「到点弹 toast」，可宿主关机、睡眠、开会时提醒等于没发生。等面板再打开，
   原逻辑会用「发布时刻」算截止：10:00 的支线 15:00 才看到只剩 1 小时，突发任务更会
   因为「超窗 2 小时」被直接收回——惩罚的是没收到提醒的人，不是拖延的人。
   这里把「离线期」单独识别出来：离线期内到点的槽位按「看到的那一刻」重新计时。 */
const OFFLINE_GAP_MIN = 30;   // 面板心跳间隔超过 30 分钟 → 视为离开过，期间的提醒没人接收
const MISS_LATE_MIN = 10;     // 发布时刻过去 10 分钟以上才算「错过」（正常打开的秒级延迟不算）
const RESCUE_PER_DAY = 1;     // 每天最多救回几个已收回的突发任务（机器关一整天不该回来一堆限时题）

/* 距上次心跳过了多少分钟（没有心跳记录时返回 0：老存档不追溯，不误判为离线） */
function offlineGapMin(lastSeenAt, nowMs){
  if(!lastSeenAt) return 0;
  return Math.max(0, (nowMs - lastSeenAt) / 60000);
}
const isOffline = (lastSeenAt, nowMs) => offlineGapMin(lastSeenAt, nowMs) >= OFFLINE_GAP_MIN;

/* 当日突发救回额度的可读状态。额度原本是隐形的：用户只有「错过且额度已耗尽」时
   才被告知，事前无从知道还剩几次。把状态算出来供 UI 常驻显示。 */
function rescueQuota(dayRec){
  const total = RESCUE_PER_DAY;
  const used = Math.max(0, (dayRec && dayRec.rescueCount) || 0);
  return { total, used, left: Math.max(0, total - used), exhausted: used >= total };
}

/* 一个「已到点但还没发布」的槽位该怎么处置。纯函数，engine 与测试共用：
   action = publish（正常发布）/ rescue（补救发布，重新计时）/ void（收回）
   tag    = 'side' | 'burst'（用于 UI 标注）；cost = 是否消耗当日的突发救回额度 */
function rescueDecision(sl, opt){
  const { nowMs, nowMinVal, dayStr, offline=false, rescueLeft=0 } = opt || {};
  const late = nowMinVal - sl.at;
  const dayEnd = new Date(dayStr+'T23:59:00').getTime();
  const burst = sl.kind === 'burst';
  // 突发任务给足 2 小时倒计时：从"看到的那一刻"算，而不是从发布时刻算。
  // 但必须夹到当天结束——否则 23:00 触发的任务截止会落到次日 01:00，
  // 变成一个挂在昨天记录里、次日还能完成的幽灵任务（连带污染次日连击与统计）。
  const burstDeadline = Math.min(dayEnd, Math.max(computeDeadline('burst', sl.at, dayStr), nowMs + 120*60000));
  if(late < MISS_LATE_MIN) return { action:'publish', deadline: burst ? burstDeadline : computeDeadline('side', sl.at, dayStr), tag:null, cost:0 };
  if(!offline){   // 宿主一直在，只是这一轮结算来得晚：按原规则，不额外开恩
    return burst && late > 120
      ? { action:'void', tag:null, cost:0, reason:'ignored' }
      : { action:'publish', deadline: burst ? burstDeadline : computeDeadline('side', sl.at, dayStr), tag:null, cost:0 };
  }
  // 离线期错过：提醒根本没被接收，按「刚发布」重新计时
  if(!burst) return { action:'rescue', deadline: Math.min(dayEnd, nowMs + SIDE_TTL_MIN*60000), tag:'side', cost:0 };
  if(late <= 120) return { action:'rescue', deadline: burstDeadline, tag:'burst', cost:0 };
  if(rescueLeft > 0) return { action:'rescue', deadline: Math.min(dayEnd, nowMs + 120*60000), tag:'burst', cost:1 };
  return { action:'void', tag:null, cost:0, reason:'budget' };
}

/* ══════════════════════════════════════════════════════════════
   系统流机制：主线任务 / 连续签到 / 称号 / 稀有度 / 每日赐福 / 连锁 / 语气
   全部为纯函数，可被 selftest 与无头测试直接覆盖。
   ══════════════════════════════════════════════════════════════ */

/* ── 1. 主线任务：把 settings.goal 变成可追踪的长线 ── */
const DEFAULT_MAIN_QUEST = {
  title: '三十天筑基', desc: '累计 30 天有进展，把「想要改变」变成「正在改变」。',   // desc 另见 mainQuestDesc()
  target: 30, progress: 0, unit: 'day', activeDays: [],
  rewardCoins: 300, rewardExp: 200, milestones: [10, 20, 30],
  doneMilestones: [], completed: false, rewardPaid: false, startedAt: 0,
};
function ensureMainQuest(S){
  if(!S.mainQuest || typeof S.mainQuest.progress!=='number') S.mainQuest = {...DEFAULT_MAIN_QUEST, startedAt: Date.now()};
  return S.mainQuest;
}
/* 完成一个任务推动主线；返回 {progress, changed, justCompleted, milestone}
   口径是「有进展的天数」，不是「完成的任务数」：一天做 1 个和做 5 个都只算 1 天。
   2026-11-17 改口径 —— 原来每完成 1 个任务 +1，可系统每天只发 2~3 个任务，
   于是「三十天筑基」12 天就能刷满（用户实测：运行 22 天早已 CLEARED，与他预期对不上）。
   名字承诺的是 30 天，机制就得数天。老存档走 backfillMainQuest() 从历史回填，不会凭空丢进度。 */
function mainQuestTick(q, dayStr){
  const idle = { progress: q? (q.progress||0) : 0, changed:false, justCompleted:false, milestone:null };
  if(!q) return idle;
  if(!Array.isArray(q.activeDays)) q.activeDays = [];
  q.doneMilestones = q.doneMilestones || [];
  if(q.completed || !dayStr || q.activeDays.includes(dayStr)) return idle;
  q.activeDays.push(dayStr);
  q.progress = Math.min(q.target, q.activeDays.length);
  let milestone = null;
  for(const m of (q.milestones||[])){
    if(q.progress >= m && !q.doneMilestones.includes(m)){ q.doneMilestones.push(m); milestone = m; break; }
  }
  if(q.progress >= q.target && !q.completed){
    q.completed = true;
    return { progress:q.progress, changed:true, justCompleted:true, milestone };
  }
  return { progress:q.progress, changed:true, justCompleted:false, milestone };
}

const OLD_MAIN_DESC = '完成 30 个任务，把「想要改变」变成「正在改变」。';
const mainQuestDesc = n => `累计 ${n} 天有进展，把「想要改变」变成「正在改变」。`;

/* 老存档语义迁移：「任务数进度」→「有进展的天数」，按历史记录回填。
   幂等：activeDays 已存在就直接跳过 —— 每次 load 都重算会把用户后来改过的目标冲掉。
   曾经按任务数判过「已完成」的，进度会退回去，但奖励不回收（既成事实、收回会掉级），
   记 rewardPaid 表示已发过，免得真正达成时再发一次。 */
function backfillMainQuest(q, days){
  if(!q || Array.isArray(q.activeDays)) return false;
  const list = Object.keys(days||{}).filter(d=>{
    const rec = days[d];
    return rec && Array.isArray(rec.slots) && rec.slots.some(sl=>sl && sl.status==='done');
  }).sort();
  const wasCompleted = !!q.completed;
  q.unit = 'day';
  q.activeDays = list;
  // 文案也跟着口径走：只在还是旧默认文案时才改，用户自己写的描述不动
  if(q.desc === OLD_MAIN_DESC) q.desc = mainQuestDesc(q.target||30);
  q.progress = Math.min(q.target||30, list.length);
  q.doneMilestones = (q.milestones||[]).filter(m=>m<=q.progress);
  q.completed = q.progress >= (q.target||30);
  if(wasCompleted) q.rewardPaid = true;
  return true;
}

/* ── 2. 连续签到阶梯：连击到 N 天额外发金币 ── */
const STREAK_BONUS = { 3:30, 7:80, 14:200, 30:500 };
function streakBonus(streak, claimed){
  const claimed_ = claimed || [];
  const table = Object.keys(STREAK_BONUS).map(Number).sort((a,b)=>a-b);
  for(const need of table){
    if(streak >= need && !claimed_.includes(need)) return { need, coins: STREAK_BONUS[need] };
  }
  return null;
}

/* ── 3. 称号：成就即称号，可自由切换穿戴 ── */
const TITLES = {
  first:'初醒者', ten:'起步者', fifty:'习惯的奴隶', streak3:'三日不辍', streak7:'七日守约',
  streak30:'铁律之身', level5:'五级宿主', level10:'十级宿主', d_rank:'越常人者',
  c_rank:'小成之人', balanced:'四维调律师', burst:'机会捕手', perfect:'一日无憾', rich:'守财奴',
};
function titleOf(achievementId){ return TITLES[achievementId] || null; }
function availableTitles(S){
  const got = new Set(S.achievements || []);
  return (S.achievements || []).filter(id=>got.has(id) && TITLES[id]).map(id=>({ id, name:TITLES[id] }));
}

/* ── 4. 任务稀有度：普通 / 稀有 / 史诗（史诗奖励 ×1.5 且播报更隆重）── */
const RARITY = {
  common: { name:'普通', weight:80, exp:1,   coins:1,   attr:1 },
  rare:   { name:'稀有', weight:17, exp:1.3, coins:1.3, attr:1.3 },
  epic:   { name:'史诗', weight:3,  exp:1.5, coins:1.5, attr:1.5 },
};
function rollRarity(rnd){
  const r = typeof rnd==='function' ? rnd() : Math.random();
  if(r < 0.03) return 'epic';
  if(r < 0.20) return 'rare';
  return 'common';
}
/* 兼容壳：等价的 settleReward（不含赐福）。
   保留是因为自检与对拍按这个名字断言；新代码请直接用 settleReward —— 单一出口。 */
function rewardsWithRarity(t){
  const r = settleReward(t, {});
  return { exp: r.exp, coins: r.coins, attr: r.attr };
}

/* ── 5. 每日系统赐福：确定性随机（同一天所有人/多次打开结果一致）── */
const BLESSINGS = [
  { id:'none',     name:'平平无奇', desc:'今日无加成。',              mult:{} },
  { id:'body',     name:'体魄恩泽', desc:'今日体质类任务奖励 ×1.5',   mult:{体质:1.5} },
  { id:'mind',     name:'智慧恩泽', desc:'今日智力类任务奖励 ×1.5',   mult:{智力:1.5} },
  { id:'spirit',   name:'心灵恩泽', desc:'今日精神类任务奖励 ×1.5',   mult:{精神:1.5} },
  { id:'discipline',name:'自律恩泽',desc:'今日自律类任务奖励 ×1.5',   mult:{自律:1.5} },
  { id:'all',      name:'全能恩泽', desc:'今日所有任务奖励 ×1.2',     mult:{'*':1.2} },
];
function blessingFor(dayStr, salt){
  const r = rngFor(dayStr+'|bless|'+salt);
  const roll = r();
  if(roll < 0.30) return BLESSINGS[0];                 // 三成概率"无加成"，免得天天满配
  return BLESSINGS[1 + Math.floor(r()*(BLESSINGS.length-1))];
}
function blessingMult(blessing, category){
  if(!blessing || !blessing.mult) return 1;
  return blessing.mult['*'] || blessing.mult[category] || 1;
}

/* ── 6. 任务连锁：完成某类任务后有概率触发后续 ── */
const CHAIN_CATEGORIES = ['智力','自律'];
function shouldChain(task, rnd){
  if(!task || !CHAIN_CATEGORIES.includes(task.category)) return false;
  const r = typeof rnd==='function' ? rnd() : Math.random();
  return r < 0.25;   // 25% 概率触发连锁
}

/* ── 6b. 取模板时避开"前几天刚做过的一模一样" ──
   起步任务与连锁任务不走 AI，只从内置池挑；池子小的时候（自律★1 曾只有两条）
   同一批标题会天天循环。这里把"近期出现过"的标题挡在候选之外，
   全都出现过时退到最久没出现的那条，仍保证不出现今天已经发过的标题。 */
const TEMPLATE_COOLDOWN_DAYS = 7;   // 一条模板用过后冷却多少天

/* days 传 S.days：recent = 近 backDays 天（含今天）出现过的标题；
   lastSeen = 标题 → 最近一次出现的日期串（冷却用尽时按它挑最久远的）。 */
function titleHistory(days, todayStr, backDays){
  const recent = new Set(), lastSeen = new Map();
  if(!days || !todayStr) return { recent, lastSeen };
  const back = Math.max(0, backDays===undefined ? TEMPLATE_COOLDOWN_DAYS : backDays|0);
  const cut = new Date(todayStr+'T00:00:00');
  cut.setDate(cut.getDate() - back);
  const cutStr = ds(cut);
  for(const d of Object.keys(days)){
    for(const sl of (days[d] && days[d].slots) || []){
      const t = sl && sl.task;
      if(!t || !t.title) continue;
      const prev = lastSeen.get(t.title);
      if(!prev || d > prev) lastSeen.set(t.title, d);
      if(d >= cutStr && d <= todayStr) recent.add(t.title);
    }
  }
  return { recent, lastSeen };
}

/* 挑模板：优先近期没出现过的；全都出现过就挑最久没出现的；
   连"今天没用过"都满足不了时返回 null，由调用方决定不发（不制造重名任务）。 */
function pickFreshTemplate(pool, hist, todayUsed, rnd){
  return pickFreshList(pool, hist, todayUsed, 1, rnd)[0] || null;
}

/* 一次挑 n 条不重名的模板（AI 结果不足、兜底任务用）：
   先把近期没出现过的洗牌，再按"最久没出现"排序补齐；今天已发过的一律不选。 */
function pickFreshList(pool, hist, todayUsed, n, rnd){
  const rand = typeof rnd==='function' ? rnd : Math.random;
  const want = Math.max(0, n|0);
  const avail = (pool||[]).filter(t=>t && t.title && !(todayUsed && todayUsed.has(t.title)));
  if(!want || !avail.length) return [];
  const fresh = avail.filter(t=>!hist.recent.has(t.title));
  const stale = avail.filter(t=>hist.recent.has(t.title))
    .sort((a,b)=>{
      const x = String(hist.lastSeen.get(a.title)||''), y = String(hist.lastSeen.get(b.title)||'');
      return x < y ? -1 : x > y ? 1 : 0;
    });
  for(let k=fresh.length-1;k>0;k--){ const j=Math.floor(rand()*(k+1)); [fresh[k],fresh[j]]=[fresh[j],fresh[k]]; }
  const out=[], taken=new Set();
  for(const t of [...fresh, ...stale]){
    if(out.length>=want) break;
    if(taken.has(t.title)) continue;
    taken.add(t.title); out.push(t);
  }
  return out;
}

/* 刚发布的任务先冷却一段时间再允许打卡：卡片重排后按钮位置会移动，
   实测出现过"任务发布 3 秒就被点完成"（连锁套连锁的推手）。 */
const COMPLETE_COOLDOWN_MS = 60*1000;
/* 完成后的撤销窗口：误点可回滚（整份存档快照，见 engine.js 的 undoComplete） */
const UNDO_WINDOW_MS = 5000;

/* ── 7. 系统语气：影响 log / toast 的措辞 ── */
const TONES = {
  cool:   { name:'冷酷', open:'【系统】', done:'记录在案。', fail:'失败已归档。' },
  sharp:  { name:'毒舌', open:'【系统·尖酸】', done:'总算动了。', fail:'又没做，我记着了。' },
  warm:   { name:'温和', open:'【系统】', done:'做得很好，继续保持。', fail:'没关系，明天再来。' },
  funny:  { name:'逗比', open:'【系统·沙雕】', done:'宿主你太强了！', fail:'翻车了，下次加油！' },
};
const DEFAULT_TONE = 'cool';

/* ── 任务池采用率统计 ──
   任务池里的条目是否被真正采用，此前无从判断：poolNote() 只是把它塞进提示词，
   AI 用不用、用了多少，没有任何记录。这里提供判定与统计的纯函数。 */
function normTitle(s){
  return String(s||'').replace(/\s+/g,'').replace(/[，。,.;；:：!！?？"'“”‘’、]/g,'').toLowerCase();
}
/* AI 常对池内任务做轻微改写，所以用"包含关系"判定而不是严格相等 */
function isFromPool(task, pool){
  const t = normTitle(task && task.title);
  if(!t) return false;
  return (pool||[]).some(p=>{
    const n = normTitle(p.title);
    if(!n) return false;
    return t===n || t.includes(n) || n.includes(t);
  });
}
function poolStats(S){
  const pool = (S.taskPool||[]);
  const poolTitles = new Map();
  for(const p of pool) poolTitles.set(normTitle(p.title), {title:p.title, issued:0, done:0, expired:0});
  let issued=0, done=0, fromPoolIssued=0, fromPoolDone=0;
  for(const k of Object.keys(S.days||{})){
    for(const sl of (S.days[k].slots||[])){
      if(!sl.task || sl.status==='waiting' || sl.status==='void') continue;
      issued++;
      const isDone = sl.status==='done' || sl.status==='partial';
      if(isDone) done++;
      // 优先用打好的 fromPool 标记；老数据没有标记则按标题回推
      const hit = sl.task.fromPool !== undefined ? sl.task.fromPool : isFromPool(sl.task, pool);
      if(hit){
        fromPoolIssued++;
        if(isDone) fromPoolDone++;
        const key = normTitle(sl.task.title);
        // 命中改写过的标题时归到最接近的那条池任务上
        let target = poolTitles.get(key);
        if(!target){
          for(const [nk,v] of poolTitles){
            if(key.includes(nk)||nk.includes(key)){ target=v; break; }
          }
        }
        if(target){
          target.issued++;
          if(isDone) target.done++;
          else if(sl.status==='expired') target.expired++;
        }
      }
    }
  }
  const neverUsed = [...poolTitles.values()].filter(v=>v.issued===0).map(v=>v.title);
  return {
    poolSize: pool.length,
    issued, done, fromPoolIssued, fromPoolDone,
    adoptionRate: issued ? Math.round(fromPoolIssued/issued*100) : 0,
    fromPoolDoneRate: fromPoolIssued ? Math.round(fromPoolDone/fromPoolIssued*100) : 0,
    overallDoneRate: issued ? Math.round(done/issued*100) : 0,
    perTask: [...poolTitles.values()].sort((a,b)=>b.issued-a.issued),
    neverUsed,
  };
}

/* ── 周报建议 → 可执行动作 ──
   周报说"补强体质"如果只能靠用户手动去任务池敲字，那这句话等于没说。
   这里把建议翻译成具体任务：从候选池里挑该维度的、且不与现有任务池重复的几条。 */
function suggestTasksFor(m, pool, existing, n=3){
  if(!m || !m.weakest) return [];
  const have = new Set((existing||[]).map(t=>String(t.title||'').trim()));
  const cands = (pool||[]).filter(t=>t.category===m.weakest && !have.has(String(t.title||'').trim()));
  // 优先难度较低、时长较短的：补弱项讲究的是可持续，一上来就排硬任务容易继续搁置
  cands.sort((a,b)=>(a.difficulty||2)-(b.difficulty||2) || (a.minutes||30)-(b.minutes||30));
  return cands.slice(0, Math.max(1,n)).map(t=>({
    title:String(t.title||'').slice(0,40),
    desc:String(t.desc||'').slice(0,200),
    category:t.category,
    difficulty:Math.min(3,Math.max(1,t.difficulty||2)),
    minutes:Math.min(120,Math.max(5,t.minutes||30)),
  }));
}

/* ── 周报指标：把"这周怎么样"变成可比较的数字 ──
   AI 只负责解读，数字必须由本地算出来——否则网关一断，周报就彻底没有内容。 */
function weekMetrics(S, anchorDay, span=7){
  const end = anchorDay || ds(new Date());
  const mkRange = (endStr, n)=>{
    const out=[];
    const e=new Date(endStr+'T00:00:00');
    for(let i=n-1;i>=0;i--){
      const d=new Date(e); d.setDate(d.getDate()-i);
      out.push(ds(d));
    }
    return out;
  };
  const cur = mkRange(end, span);
  const prevEnd = new Date(end+'T00:00:00'); prevEnd.setDate(prevEnd.getDate()-span);
  const prev = mkRange(ds(prevEnd), span);

  const agg = (days)=>{
    let done=0,total=0,expired=0,voided=0,partial=0,coins=0,exp=0;
    const byCat={};
    // 补救复盘：错过几次、救回几次、额度用光几天、最长离开多久
    const rs = { events:0, side:0, burst:0, grace:0, quotaUsed:0, quotaDays:0, awayDays:0, maxGap:0 };
    for(const k of days){
      const rec=S.days[k]; if(!rec) continue;
      const r = rec.rescue;
      if(r && r.n){
        rs.events += r.n;
        rs.side += r.side||0;
        rs.burst += r.burst||0;
        rs.grace += r.grace||0;
        rs.awayDays += 1;
        rs.maxGap = Math.max(rs.maxGap, Math.round(r.gapMin||0));
      }
      const used = Math.max(0, rec.rescueCount||0);
      if(used>0){ rs.quotaUsed += used; rs.quotaDays += 1; }
      for(const sl of rec.slots||[]){
        const st=sl.status;
        if(st==='waiting') continue;
        total++;
        if(st==='done') done++;
        else if(st==='expired') expired++;
        else if(st==='void') voided++;
        else if(st==='partial') partial++;
        if((st==='done'||st==='partial') && sl.task){
          byCat[sl.task.category]=(byCat[sl.task.category]||0)+1;
        }
      }
    }
    const rate = total? Math.round(done/total*100) : 0;
    const activeDays = days.filter(k=>{
      const rec=S.days[k];
      return rec && (rec.slots||[]).some(sl=>sl.status==='done'||sl.status==='partial');
    }).length;
    return {done,total,expired,voided,partial,rate,activeDays,byCat,rescue:rs};
  };

  const c=agg(cur), p=agg(prev);
  // 四维增量：区间内最早与最晚两张快照相比。
  // 基准优先级：① 区间内第一张之前最近的一张 → ② 区间内第一张快照自身 → ③ 无。
  // 早期只有 1~2 张快照时也要能出数，否则新用户永远看到"快照不足"。
  const attrDelta=(days)=>{
    const snaps=Object.keys(S.days).filter(k=>S.days[k]&&S.days[k].snap).sort();
    const inRange=snaps.filter(k=>days.includes(k));
    if(!inRange.length) return null;
    const last=inRange[inRange.length-1];
    const before=snaps.filter(k=>k<days[0]).pop();
    // 区间内只有一张快照且没有更早的基准 → 无法算增量，如实返回 null
    const baseKey = before || (inRange.length>=2 ? inRange[0] : null);
    if(!baseKey) return null;
    const base = S.days[baseKey].snap.attrs || {};
    const out={};
    for(const cat of CATS) out[cat]=(S.days[last].snap.attrs[cat]||0)-(base[cat]||0);
    return out;
  };

  const cats=Object.keys(c.byCat).sort((a,b)=>c.byCat[b]-c.byCat[a]);
  return {
    range:{from:cur[0], to:cur[cur.length-1]},
    prevRange:{from:prev[0], to:prev[prev.length-1]},
    cur:c, prev:p,
    rateDelta: c.rate-p.rate,
    doneDelta: c.done-p.done,
    attrDelta: attrDelta(cur),
    streak: computeStreak(S.days, end, S.shieldedDays),
    strongest: cats[0]||null,
    // 补救复盘：本周错过的次数、救回构成、额度消耗，以及与上周的对比
    rescueDelta: c.rescue.events - p.rescue.events,
    rescueInsight: rescueInsight(c.rescue, c.total),
    // 诊断要能直接接上修复：给出「建议的活跃窗口」，而不是只让用户自己去改
    windowSuggestion: suggestActiveWindow(S, end, span),
    // 最该补的维度：四维里当前最低的一维
    weakest: CATS.slice().sort((a,b)=>(S.player.attrs[a]||0)-(S.player.attrs[b]||0))[0]||null,
    weakestValue: (()=>{
      const w = CATS.slice().sort((a,b)=>(S.player.attrs[a]||0)-(S.player.attrs[b]||0))[0];
      return w ? (S.player.attrs[w]||0) : 0;
    })(),
  };
}

/* 从真实完成时刻反推活跃窗口。
   补救反复触发说明发布时段与作息错位，但「该改成几点」不该让用户自己拍脑袋。
   用近 N 天实际完成时间取分位：个别深夜/凌晨的极端点不会把窗口拉到离谱。 */
const WINDOW_MIN_SAMPLES = 3;
function suggestActiveWindow(S, anchorDay, span=7){
  const end = anchorDay || ds(new Date());
  const from = new Date(end+'T00:00:00');
  from.setDate(from.getDate()-(span-1));
  const fromStr = ds(from);
  const mins = [];
  for(const k of Object.keys(S.days||{})){
    if(k<fromStr || k>end) continue;
    for(const sl of S.days[k].slots||[]){
      if(sl.status!=='done' && sl.status!=='partial') continue;
      const t = sl.settledAt || sl.partialAt;
      if(!t) continue;
      const d = new Date(t);
      mins.push(d.getHours()*60 + d.getMinutes());
    }
  }
  // 样本太少就不建议：凭 1-2 次完成时间改设置，比不改更糟
  if(mins.length < WINDOW_MIN_SAMPLES) return null;
  mins.sort((a,b)=>a-b);
  const pick = p => mins[Math.min(mins.length-1, Math.max(0, Math.round((mins.length-1)*p)))];
  let start = pick(0.10) - 30;      // 两侧各留 30 分钟余量
  let stop  = pick(0.90) + 30;
  if(stop - start < 180){           // 窗口太窄会让任务全挤在一两个小时里
    const mid = (start+stop)/2;
    start = mid - 90; stop = mid + 90;
  }
  const clamp = v => Math.max(6*60, Math.min(23*60+30, v));
  start = clamp(Math.floor(start/30)*30);
  stop  = clamp(Math.ceil(stop/30)*30);
  if(stop <= start) stop = Math.min(23*60+30, start+180);
  const hmStr = v => String(Math.floor(v/60)).padStart(2,'0')+':'+String(v%60).padStart(2,'0');
  const out = { start:hmStr(start), end:hmStr(stop), samples:mins.length };
  out.changed = out.start!==S.settings.dayStart || out.end!==S.settings.dayEnd;
  return out;
}

/* 补救复盘结论：把「错过几次」变成一句能指导行动的话。
   补救反复发生说明的不是"不够努力"，而是「系统发布时段」与「真实作息」错位。 */
function rescueInsight(rs, total){
  if(!rs || !rs.events) {
    return { level:'ok', text:'这周没有因离开而错过提醒，发布时段与你的作息是匹配的。' };
  }
  const share = total ? Math.round(rs.events/total*100) : 0;
  const bits = [];
  if(rs.burst) bits.push(`突发救回 ${rs.burst} 次`);
  if(rs.side) bits.push(`支线重计时 ${rs.side} 次`);
  if(rs.grace) bits.push(`补交窗口 ${rs.grace} 次`);
  const detail = bits.join('、');
  if(rs.quotaDays >= 2 || share >= 30){
    return { level:'warn',
      text:`有 ${rs.awayDays} 天在离开期间错过提醒（${detail}），其中 ${rs.quotaDays} 天用光了救回额度。这不是执行问题，是发布时段与你的作息错位——建议把活跃窗口调到你确实在看屏幕的时段。` };
  }
  return { level:'note',
    text:`有 ${rs.awayDays} 天在离开期间错过提醒（${detail}），已被补救机制接住，未造成实质损失。` };
}

/* 无 AI 时的本地兜底周报：用真实数字拼一份，保证断网也有内容。
   刻意只依赖传入的指标对象 m（不读全局 S），保持 core 层纯函数可测。 */
function localReport(m){
  const L=[];
  const r=m.cur, pr=m.prev;
  if(r.total===0){
    return '这 7 天系统没有发出任何任务记录，成长档案是空白的。\n\n下一步：确认活跃窗口设置（设置页）符合你的作息，让系统能在你清醒的时段发布任务。';
  }
  L.push(`整体评价：本周完成 ${r.done}/${r.total}（${r.rate}%），连续打卡 ${m.streak} 天，有效行动 ${r.activeDays} 天。` +
    (pr.total? `对比上周 ${pr.rate}%，${m.rateDelta>0?'提升':m.rateDelta<0?'下降':'持平'} ${Math.abs(m.rateDelta)} 个百分点。` : '（上周无数据，暂无可比基线）'));
  if(m.strongest) L.push(`亮点：${m.strongest} 维度投入最多（本周 ${r.byCat[m.strongest]} 次），维持住了主攻方向。`);
  if(m.attrDelta){
    const up=Object.entries(m.attrDelta).filter(([,v])=>v>0).map(([k,v])=>`${k}+${v}`);
    if(up.length) L.push(`属性增量：${up.join('、')}。`);
  }
  const problems=[];
  if(r.expired>0) problems.push(`${r.expired} 个任务失效`);
  if(r.voided>0) problems.push(`${r.voided} 个突发任务被收回`);
  if(r.partial>0) problems.push(`${r.partial} 个任务停在半奖状态未收尾`);
  if(problems.length) L.push(`问题与盲区：${problems.join('，')}。`);
  if(m.rescueInsight) L.push(`补救复盘：${m.rescueInsight.text}`);
  if(m.weakest){
    const v=m.weakestValue||0;
    L.push(`下周建议：① 补强最薄弱的「${m.weakest}」（当前 ${v}，${attrRank(v)} 级），给它排 2-3 个任务；② 把每日第一个任务放在精力最好的时段，减少失效；③ 若常做同类任务，把它沉淀进任务池，减少出题随机性。`);
  }
  return L.join('\n');
}

/* ── 自检（核心逻辑的最小可运行校验）── */
function selftest(){
  const A=(name,cond)=>{ console.assert(cond,'FAIL: '+name); if(!cond) ok=false; return cond; };
  let ok=true;
  const win={start:'09:00',end:'22:00'};
  const a=planDay('2026-10-26',12345,win), b=planDay('2026-10-26',12345,win);
  A('同种子同结果', JSON.stringify(a)===JSON.stringify(b));
  A('槽位结构合法', a.length>=2&&a.length<=3&&a.every(s=>s.at>=540&&s.at<=1320&&['side','burst'].includes(s.kind)));
  const c=planDay('2026-10-26',99999,win);
  A('异种子异结果', JSON.stringify(a)!==JSON.stringify(c));
  const r1=rewards({difficulty:2,kind:'side'}), r2=rewards({difficulty:2,kind:'burst'});
  A('奖励公式', r1.exp===30&&r1.coins===16&&r1.attr===8&&r2.exp===60&&r2.coins===32);
  A('难度钳制', rewards({difficulty:99,kind:'side'}).exp===45);
  A('经验曲线单调', expToNext(1)<expToNext(5)&&expToNext(5)<expToNext(9));
  A('支线截止=发布+6h', computeDeadline('side',600,'2026-10-26')===new Date('2026-10-26T16:00:00').getTime());
  A('支线截止不越过当日末', computeDeadline('side',23*60+50,'2026-10-26')===new Date('2026-10-26T23:59:00').getTime());
  A('突发截止=触发+2h', computeDeadline('burst',600,'2026-10-26')===new Date('2026-10-26T12:00:00').getTime());
  const mk=(st)=>({slots:[{status:st}]});
  const D={ '2026-10-25':mk('done'), '2026-10-24':mk('done'), '2026-10-23':mk('expired') };
  D['2026-10-26']=mk('done');
  A('streak含今日', computeStreak(D,'2026-10-26')===3);
  delete D['2026-10-26'];
  A('streak今日未完不算断', computeStreak(D,'2026-10-26')===2);
  A('dayStats分类', dayStats(D,'2026-10-23').expired===1&&dayStats(D,'2026-10-23').total===1);
  // 分段推进
  A('长任务可拆分', canSplit({minutes:30,difficulty:2})===true);
  A('短任务不可拆分', canSplit({minutes:10,difficulty:2})===false);
  A('难度1不可拆分', canSplit({minutes:30,difficulty:1})===false);
  const h=halfRewards({difficulty:2,kind:'side'});
  A('半奖励=整奖励一半', h.exp===15&&h.coins===8&&h.attr===4);
  // 商城进度
  const sp=shopProgress(64,200);
  A('商城进度换算', sp.pct===32&&sp.need===136&&sp.tasks===9);
  A('金币足够时进度=100', shopProgress(300,200).pct===100&&shopProgress(300,200).need===0);
  // 成就（纯函数 + 去重）
  const S0={player:{level:1,exp:0,coins:0,attrs:{体质:0,智力:0,精神:0,自律:0}},stats:{done:1,expired:0},days:{},achievements:[]};
  A('首个成就解锁', checkAchievements(S0).includes('first'));
  S0.achievements=['first'];
  A('已解锁不重复返回', !checkAchievements(S0).includes('first'));
  A('四维均衡需四维都达标', !checkAchievements(S0).includes('balanced'));
  S0.player.attrs={体质:40,智力:40,精神:40,自律:40};
  A('四维达标后解锁', checkAchievements(S0).includes('balanced'));
  // 补交拉力
  const win2={start:'09:00',end:'22:00'};
  const day0={slots:[{at:600,status:'expired'},{at:700,status:'expired'}]};
  A('窗口过半且零完成→需要起步任务', needsStarterTask(day0, 20*60, win2)===true);
  A('窗口未过半→不需要', needsStarterTask(day0, 12*60, win2)===false);
  A('已有完成→不需要', needsStarterTask({slots:[{at:600,status:'done'}]}, 20*60, win2)===false);
  A('一天只给一次', needsStarterTask({slots:[{at:600,status:'expired'}],starter:true}, 20*60, win2)===false);
  // 错过提醒的补救
  const nowM0 = new Date('2026-10-26T15:00:00').getTime();
  const rd = (sl,o={}) => rescueDecision(sl, {nowMs:nowM0, nowMinVal:15*60, dayStr:'2026-10-26', ...o});
  A('到点即发布不算错过', rd({at:14*60+55,kind:'side'}).action==='publish');
  A('离线错过支线→重新计时', rd({at:600,kind:'side'},{offline:true}).action==='rescue'&&rd({at:600,kind:'side'},{offline:true}).tag==='side');
  A('支线补救从此刻起算 6 小时', rd({at:600,kind:'side'},{offline:true}).deadline===nowM0+360*60000);
  A('支线补救不越过当日末', rescueDecision({at:600,kind:'side'},{nowMs:new Date('2026-10-26T22:00:00').getTime(),nowMinVal:22*60,dayStr:'2026-10-26',offline:true}).deadline===new Date('2026-10-26T23:59:00').getTime());
  A('在线拖过 2 小时的突发→收回', rd({at:600,kind:'burst'},{offline:false}).action==='void');
  A('离线超窗突发→救回一次', rd({at:600,kind:'burst'},{offline:true,rescueLeft:1}).action==='rescue'&&rd({at:600,kind:'burst'},{offline:true,rescueLeft:1}).cost===1);
  A('救回额度用完→收回', rd({at:600,kind:'burst'},{offline:true,rescueLeft:0}).action==='void'&&rd({at:600,kind:'burst'},{offline:true,rescueLeft:0}).reason==='budget');
  A('离线但未超窗的突发不耗额度', rd({at:14*60,kind:'burst'},{offline:true,rescueLeft:0}).action==='rescue'&&rd({at:14*60,kind:'burst'},{offline:true,rescueLeft:0}).cost===0);
  A('无心跳记录不判离线', isOffline(undefined, nowM0)===false&&isOffline(0, nowM0)===false);
  A('心跳间隔决定离线', isOffline(nowM0-31*60000, nowM0)===true&&isOffline(nowM0-10*60000, nowM0)===false);
  // 救回额度的可读状态
  A('额度初始为满', rescueQuota({}).left===RESCUE_PER_DAY&&rescueQuota({}).exhausted===false);
  A('额度用掉后减少', rescueQuota({rescueCount:1}).left===0&&rescueQuota({rescueCount:1}).used===1);
  A('额度耗尽标记正确', rescueQuota({rescueCount:RESCUE_PER_DAY}).exhausted===true);
  A('额度不会为负', rescueQuota({rescueCount:99}).left===0);
  A('空记录不报错', rescueQuota(null).total===RESCUE_PER_DAY);
  // 补救复盘（周报）
  const RS0={events:0,side:0,burst:0,grace:0,quotaUsed:0,quotaDays:0,awayDays:0,maxGap:0};
  A('无错过时结论为 ok', rescueInsight(RS0,10).level==='ok'&&rescueInsight(RS0,10).text.includes('匹配'));
  A('少量错过为 note', rescueInsight({...RS0,events:2,side:1,burst:1,awayDays:2},20).level==='note');
  A('额度用光多天升级为 warn', rescueInsight({...RS0,events:5,burst:3,awayDays:3,quotaDays:2},20).level==='warn');
  A('错过占比高也升级为 warn', rescueInsight({...RS0,events:6,side:6,awayDays:2,quotaDays:0},15).level==='warn');
  A('warn 结论指向作息错位', rescueInsight({...RS0,events:5,burst:3,awayDays:3,quotaDays:2},20).text.includes('作息'));
  {
    const WRS={player:{attrs:{体质:0,智力:50,精神:0,自律:0}},log:[],stats:{done:0,expired:0},
      days:{
        '2026-10-27':{slots:[{status:'done',task:{category:'智力'}}],
          rescue:{at:1,n:2,side:1,burst:1,grace:0,gapMin:95},rescueCount:1},
        '2026-10-28':{slots:[{status:'expired',task:{category:'体质'}}],
          rescue:{at:1,n:1,side:0,burst:0,grace:1,gapMin:40},rescueCount:0},
      }};
    const wmR=weekMetrics(WRS,'2026-10-28',7);
    A('周报汇总错过次数', wmR.cur.rescue.events===3, wmR.cur.rescue.events);
    A('周报区分支线/突发/补交', wmR.cur.rescue.side===1&&wmR.cur.rescue.burst===1&&wmR.cur.rescue.grace===1);
    A('周报统计离开天数', wmR.cur.rescue.awayDays===2, wmR.cur.rescue.awayDays);
    A('周报统计最长离开', wmR.cur.rescue.maxGap===95, wmR.cur.rescue.maxGap);
    A('周报统计额度用光天数', wmR.cur.rescue.quotaDays===1, wmR.cur.rescue.quotaDays);
    A('周报带补救结论', !!wmR.rescueInsight&&typeof wmR.rescueInsight.text==='string');
    A('本地周报含补救复盘段', localReport(wmR).includes('补救复盘'));
  }
  // 活跃窗口建议（诊断 → 修复）
  {
    const mkWin=(times)=>({settings:{dayStart:'09:00',dayEnd:'22:00'},
      days:{'2026-10-28':{slots:times.map(t=>{const [h,m]=t.split(':');
        return {status:'done',settledAt:new Date('2026-10-28T'+h+':'+m+':00').getTime()};})}}});
    const w1=suggestActiveWindow(mkWin(['19:30','20:00','21:15','20:40','19:50']),'2026-10-28');
    A('窗口建议给出起止', !!w1&&/^\d\d:\d\d$/.test(w1.start)&&/^\d\d:\d\d$/.test(w1.end), JSON.stringify(w1));
    A('窗口建议落在晚间', w1&&w1.start>='18:00'&&w1.end<='23:30', JSON.stringify(w1));
    A('窗口建议标注样本数', w1&&w1.samples===5, w1&&w1.samples);
    A('样本不足不给建议', suggestActiveWindow(mkWin(['20:00','20:30']),'2026-10-28')===null);
    A('无完成记录不给建议', suggestActiveWindow({settings:{dayStart:'09:00',dayEnd:'22:00'},days:{}},'2026-10-28')===null);
    const w2=suggestActiveWindow(mkWin(['20:00','20:05','20:10','20:15']),'2026-10-28');
    A('窗口过窄会被撑到至少 3 小时', (()=>{
      const toM=s=>+s.slice(0,2)*60+ +s.slice(3);
      return w2 && toM(w2.end)-toM(w2.start)>=180;
    })(), JSON.stringify(w2));
    A('窗口不会越过 06:00~23:30', (()=>{
      const w=suggestActiveWindow(mkWin(['23:20','23:25','23:28']),'2026-10-28');
      return w && w.end<='23:30';
    })());
    const same={settings:{dayStart:'18:30',dayEnd:'22:00'},
      days:{'2026-10-28':{slots:['19:30','20:00','21:15'].map(t=>{const [h,m]=t.split(':');
        return {status:'done',settledAt:new Date('2026-10-28T'+h+':'+m+':00').getTime()};})}}};
    A('与当前设置一致时 changed=false', (()=>{
      const w=suggestActiveWindow(same,'2026-10-28');
      return w && w.changed===false;
    })(), JSON.stringify(suggestActiveWindow(same,'2026-10-28')));
    A('partial 也计入样本', (()=>{
      const s={settings:{dayStart:'09:00',dayEnd:'22:00'},days:{'2026-10-28':{slots:[
        {status:'partial',partialAt:new Date('2026-10-28T20:00:00').getTime()},
        {status:'done',settledAt:new Date('2026-10-28T20:10:00').getTime()},
        {status:'done',settledAt:new Date('2026-10-28T20:20:00').getTime()},
        {status:'expired'}]}}};
      const w=suggestActiveWindow(s,'2026-10-28');
      return w && w.samples===3;
    })());
  }
  // 突发截止不得跨天：23:00 触发的任务若给满 2 小时会落到次日 01:00，变成挂在昨天记录里的幽灵任务
  {
    const lateNight = new Date('2026-10-26T23:05:00').getTime();
    const dd = rescueDecision({at:23*60,kind:'burst'},
      {nowMs:lateNight, nowMinVal:23*60+5, dayStr:'2026-10-26', offline:false});
    A('夜间突发的截止被夹到当日末', dd.deadline===new Date('2026-10-26T23:59:00').getTime(),
      new Date(dd.deadline).toLocaleString('zh-CN'));
    A('夜间突发不产生跨天幽灵任务', new Date(dd.deadline).getDate()===26, dd.deadline);
    // 白天触发仍然给满 2 小时（不该被误夹）
    const noon = new Date('2026-10-26T14:00:00').getTime();
    const dd2 = rescueDecision({at:14*60,kind:'burst'},
      {nowMs:noon, nowMinVal:14*60, dayStr:'2026-10-26', offline:false});
    A('白天突发仍给足 2 小时', dd2.deadline===noon+120*60000, (dd2.deadline-noon)/60000);
    // 晚几分钟才看到：倒计时应从「看到的那一刻」起算，而不是从发布时刻。
    // late=0 时 computeDeadline 恰好等于 now+2h，两种算法结果相同、区分不出来，
    // 所以必须用 late>0 的场景才能真正锁定这条规则。
    const late5 = new Date('2026-10-26T14:05:00').getTime();
    const dd2b = rescueDecision({at:14*60,kind:'burst'},
      {nowMs:late5, nowMinVal:14*60+5, dayStr:'2026-10-26', offline:false});
    A('晚看到几分钟也从此刻起算 2 小时', dd2b.deadline===late5+120*60000,
      (dd2b.deadline-late5)/60000);
    // 夜间离线救回同样不得跨天
    const dd3 = rescueDecision({at:22*60,kind:'burst'},
      {nowMs:lateNight, nowMinVal:23*60+5, dayStr:'2026-10-26', offline:true, rescueLeft:1});
    A('夜间救回的截止也不跨天', new Date(dd3.deadline).getDate()===26, new Date(dd3.deadline).toLocaleString('zh-CN'));
  }
  // 主线任务（口径：有进展的天数）
  const q={...DEFAULT_MAIN_QUEST, target:3, progress:0, activeDays:[], doneMilestones:[], completed:false, milestones:[1,2,3]};
  const pr1=mainQuestTick(q,'2026-10-26');
  A('主线记录有进展的一天', pr1.changed===true&&q.progress===1, JSON.stringify(pr1));
  const pr1b=mainQuestTick(q,'2026-10-26');
  A('同一天多个任务只算一天', pr1b.changed===false&&q.activeDays.length===1, JSON.stringify(q.activeDays));
  mainQuestTick(q,'2026-10-27');
  const pr2=mainQuestTick(q,'2026-10-28');
  A('满 3 天触发达标', pr2.justCompleted===true&&q.completed===true&&q.progress===3, JSON.stringify(pr2));
  A('达标同时记录里程碑', q.doneMilestones.includes(3), JSON.stringify(q.doneMilestones));
  A('已完成的主线不再推进', mainQuestTick(q,'2026-10-29').changed===false&&q.progress===3);
  // 老存档迁移：按历史里有完成记录的日期回填
  const q2={...DEFAULT_MAIN_QUEST, progress:30, doneMilestones:[10,20,30], completed:true};
  delete q2.activeDays;   // 模拟老存档：这个字段当时还不存在（有它就等于已迁移过）
  const migrated=backfillMainQuest(q2, {
    '2026-10-26':{slots:[{status:'done'}]},
    '2026-10-27':{slots:[{status:'done'}]},
    '2026-10-28':{slots:[{status:'expired'}]},
  });
  A('老存档按活跃天数回填', migrated===true&&q2.progress===2&&q2.completed===false, JSON.stringify({p:q2.progress,c:q2.completed}));
  A('迁移后标记奖励已发', q2.rewardPaid===true);
  A('迁移幂等', backfillMainQuest(q2,{})===false&&q2.progress===2);
  // 连续签到
  A('连击 3 天发奖', streakBonus(3,[])!==null&&streakBonus(3,[]).coins===30);
  A('已领过不再发', streakBonus(3,[3])===null);
  A('连击 8 天领 7 天档', streakBonus(8,[3]).need===7);
  A('无连击无奖励', streakBonus(0,[])===null);
  // 称号
  A('成就有对应称号', titleOf('first')==='初醒者'&&titleOf('streak7')==='七日守约');
  A('未知成就无称号', titleOf('nope')===null);
  A('可用称号只含已解锁', availableTitles({achievements:['first','nope']}).length===1);
  // 稀有度
  A('史诗奖励 ×1.5', rewardsWithRarity({difficulty:2,kind:'side',rarity:'epic'}).exp===45);
  A('普通奖励不变', rewardsWithRarity({difficulty:2,kind:'side',rarity:'common'}).exp===30);
  A('缺省稀有度按普通', rewardsWithRarity({difficulty:2,kind:'side'}).coins===16);
  A('稀有度掷骰可判定', rollRarity(()=>0.01)==='epic'&&rollRarity(()=>0.5)==='common');
  // 每日赐福（确定性）
  const b1=blessingFor('2026-10-28',1), b2=blessingFor('2026-10-28',1);
  A('赐福同日同结果', b1.id===b2.id);
  A('赐福是已知条目', BLESSINGS.some(x=>x.id===b1.id));
  A('赐福倍率生效', blessingMult({mult:{智力:1.5}},'智力')===1.5&&blessingMult({mult:{智力:1.5}},'体质')===1);
  A('全能赐福对所有维度生效', blessingMult({mult:{'*':1.2}},'自律')===1.2);
  // 连锁与语气
  A('智力任务可连锁', shouldChain({category:'智力'},()=>0.1)===true);
  A('体质任务不连锁', shouldChain({category:'体质'},()=>0.1)===false);
  A('连锁概率判定', shouldChain({category:'智力'},()=>0.9)===false);
  // 近期标题避让（起步/连锁取模板用）
  {
    const days = {
      '2026-10-30': { slots:[{task:{title:'旧任务'}}, {task:null}] },
      '2026-10-31': { slots:[{task:{title:'昨天的任务'}}] },
      '2026-11-01': { slots:[{task:{title:'今天已完成'}}] },
    };
    const h = titleHistory(days, '2026-11-01', 7);
    A('近期标题含近 7 天', h.recent.has('旧任务') && h.recent.has('昨天的任务') && h.recent.has('今天已完成'));
    A('近期标题不含窗口外', titleHistory(days,'2026-11-01',1).recent.has('旧任务')===false);
    A('记录最近出现日期', h.lastSeen.get('昨天的任务')==='2026-10-31');
    A('优先挑近期没出现过的', pickFreshTemplate([{title:'昨天的任务'},{title:'全新任务'}], h, new Set(), ()=>0).title==='全新任务');
    const h2 = titleHistory({ '2026-10-28':{slots:[{task:{title:'A'}}]}, '2026-10-30':{slots:[{task:{title:'B'}}]} }, '2026-11-01', 7);
    A('近期全用过时挑最久没出现的', pickFreshTemplate([{title:'B'},{title:'A'}], h2, new Set(), ()=>0).title==='A');
    A('今天用过且近期全用过则不发', pickFreshTemplate([{title:'A'}], h2, new Set(['A']), ()=>0)===null);
  }
  A('四种语气齐全', Object.keys(TONES).length===4&&TONES.cool.name==='冷酷');
  // 属性等级 / 跨级
  A('等级边界正确', attrRank(39)==='F'&&attrRank(40)==='E'&&attrRank(90)==='D'&&attrRank(160)==='C'&&attrRank(260)==='B'&&attrRank(400)==='A'&&attrRank(600)==='S');
  A('未跨级返回 null', rankUpgrade(41,45)===null);
  A('E 跨 D 能识别', rankUpgrade(88,91)!==null&&rankUpgrade(88,91).rank==='D');
  A('一次跨多级取最终级', rankUpgrade(39,170).rank==='C');
  A('距下一级差多少', nextRankGap(80).need===10&&nextRankGap(80).next.rank==='D');
  A('满级无下一级', nextRankGap(700)===null);
  A('等级名称可读', rankInfo(100).name==='入门'&&rankInfo(0).name==='未觉醒');
  // 周报指标（2026-10-21 往前 7 天 = 10-15~10-21）
  const WS={player:{attrs:{体质:10,智力:50,精神:20,自律:30},level:2,exp:0},
    days:{
      '2026-10-19':{slots:[{status:'done',task:{category:'智力'}},{status:'expired',task:{category:'体质'}}]},
      '2026-10-20':{slots:[{status:'done',task:{category:'智力'}},{status:'done',task:{category:'精神'}}]},
      '2026-10-14':{slots:[{status:'done',task:{category:'体质'}}]},
    }, log:[], stats:{done:4,expired:1}};
  const wm=weekMetrics(WS,'2026-10-21',7);
  A('周报统计完成数', wm.cur.done===3, JSON.stringify(wm.cur));
  A('周报完成率按有效任务算', wm.cur.total===4&&wm.cur.rate===75, `total=${wm.cur.total} rate=${wm.cur.rate}`);
  A('周报识别最强维度', wm.strongest==='智力');
  A('周报识别最弱维度', wm.weakest==='体质');
  A('周报给出区间日期', wm.range.to==='2026-10-21'&&wm.range.from==='2026-10-15', JSON.stringify(wm.range));
  A('周报排除了窗口外数据', wm.cur.done===3, `done=${wm.cur.done}`);
  const LR=localReport(wm);
  A('本地兜底周报非空', typeof LR==='string'&&LR.length>30);
  A('本地周报含完成率', LR.includes('75%'));
  const EMPTY=localReport(weekMetrics({player:{attrs:{体质:0,智力:0,精神:0,自律:0},level:1,exp:0},days:{},log:[],stats:{done:0,expired:0}},'2026-10-21',7));
  A('空数据周报有引导而非报错', EMPTY.includes('空白')||EMPTY.includes('没有'));
  // 属性增量：区间内两张快照即可算，不必等区间前有基准
  const WS2={player:{attrs:{体质:5,智力:60,精神:5,自律:5},level:2,exp:0},
    days:{
      '2026-10-27':{snap:{attrs:{体质:0,智力:40,精神:0,自律:0}},slots:[]},
      '2026-10-28':{snap:{attrs:{体质:2,智力:52,精神:0,自律:0}},slots:[]},
    }, log:[], stats:{done:0,expired:0}};
  const wm2=weekMetrics(WS2,'2026-10-28',7);
  A('两张快照即可算增量', wm2.attrDelta!==null, JSON.stringify(wm2.attrDelta));
  A('增量数值正确', wm2.attrDelta&&wm2.attrDelta['智力']===12, wm2.attrDelta&&wm2.attrDelta['智力']);
  const WS3={player:{attrs:{体质:0,智力:0,精神:0,自律:0}},days:{'2026-10-28':{snap:{attrs:{体质:0,智力:9,精神:0,自律:0}},slots:[]}},log:[],stats:{done:0,expired:0}};
  A('只有一张快照时增量留空', weekMetrics(WS3,'2026-10-28',7).attrDelta===null);
  // 周报建议 → 任务池
  const POOL=[
    {title:'快走20分钟',category:'体质',difficulty:2,minutes:20,desc:''},
    {title:'俯卧撑3组',category:'体质',difficulty:1,minutes:15,desc:''},
    {title:'读书20页',category:'智力',difficulty:2,minutes:30,desc:''},
    {title:'拉伸10分钟',category:'体质',difficulty:1,minutes:10,desc:''},
  ];
  const sug=suggestTasksFor({weakest:'体质'}, POOL, [], 3);
  A('建议只取最薄弱维度', sug.length===3&&sug.every(t=>t.category==='体质'), JSON.stringify(sug.map(t=>t.category)));
  A('建议优先低难度短时长', sug[0].difficulty===1&&sug[0].minutes<=15, JSON.stringify(sug[0]));
  A('建议排除任务池已有的', suggestTasksFor({weakest:'体质'}, POOL, [{title:'俯卧撑3组'}], 3).every(t=>t.title!=='俯卧撑3组'));
  A('无最薄弱维度则不返回', suggestTasksFor({}, POOL, [], 3).length===0);
  A('候选不足时有多少给多少', suggestTasksFor({weakest:'精神'}, POOL, [], 3).length===0);
  A('建议条目字段完整', sug[0].title&&sug[0].category&&sug[0].difficulty&&sug[0].minutes);
  // 任务池采用率
  A('标题归一化去空白标点', normTitle('  读书，20页！ ')==='读书20页');
  A('严格同名算池内', isFromPool({title:'拉伸10分钟'},[{title:'拉伸10分钟'}]));
  A('AI 加长标题也算池内', isFromPool({title:'拉伸 10 分钟（重点肩颈）'},[{title:'拉伸10分钟'}]));
  A('不相干任务不算池内', !isFromPool({title:'写代码'},[{title:'拉伸10分钟'}]));
  A('空任务不算池内', !isFromPool({title:''},[{title:'拉伸10分钟'}]));
  const PS=poolStats({taskPool:[{title:'拉伸10分钟'},{title:'读书20页'}],
    days:{'2026-10-28':{slots:[
      {status:'done',task:{title:'拉伸10分钟'}},
      {status:'expired',task:{title:'AI自拟'}},
      {status:'done',task:{title:'读书'}},
    ]}}});
  A('池统计发布总数', PS.issued===3, PS.issued);
  A('池统计池内采用数', PS.fromPoolIssued===2, PS.fromPoolIssued);
  A('池统计采用率', PS.adoptionRate===67, PS.adoptionRate);
  A('池统计完成率', PS.fromPoolDoneRate===100, PS.fromPoolDoneRate);
  A('池统计空池安全', poolStats({taskPool:[],days:{}}).adoptionRate===0);
  A('识别从未采用的任务', poolStats({taskPool:[{title:'没用过'},{title:'用过'}],
    days:{'2026-10-28':{slots:[{status:'done',task:{title:'用过'}}]}}}).neverUsed.join()==='没用过');

  /* ── 结算链（settleReward）：唯一奖励出口 ── */
  {
    const t1 = {difficulty:2, kind:'side', category:'智力'};
    const s0 = settleReward(t1, {});
    A('结算链：普通任务无加成', s0.exp===30&&s0.coins===16&&s0.attr===8, JSON.stringify(s0));
    A('结算链：稀有度生效', settleReward({...t1,rarity:'epic'},{}).exp===45);
    A('结算链：赐福生效', settleReward(t1,{blessing:1.5}).exp===45, settleReward(t1,{blessing:1.5}).exp);
    A('结算链：稀有度与赐福叠乘', settleReward({...t1,rarity:'epic'},{blessing:1.5}).exp===68, settleReward({...t1,rarity:'epic'},{blessing:1.5}).exp);
    A('结算链：半奖不吃稀有度', settleReward({...t1,rarity:'epic'},{partial:true}).exp===15);
    A('结算链：半奖不吃赐福', settleReward(t1,{partial:true,blessing:1.5}).exp===15);
    A('结算链：突发 ×2 保留', settleReward({difficulty:2,kind:'burst'},{}).exp===60);
    A('结算链：factors 可解释', (function(){const r=settleReward({...t1,rarity:'rare'},{blessing:1.5});return r.factors.rarity===1.3&&r.factors.blessing===1.5;})());
    // 卡片预览与实发必须同源
    A('结算链是 rewardsWithRarity 的超集', (function(){
      const a=settleReward({...t1,rarity:'rare'},{});
      const b=rewardsWithRarity({...t1,rarity:'rare'});
      return a.exp===b.exp&&a.coins===b.coins&&a.attr===b.attr;
    })());
  }

  /* ── 连胜护盾 ── */
  {
    A('护盾账本：未发放时剩 0', shieldLedger(0,0).left===0);
    A('护盾账本：发放 1 消耗 0', shieldLedger(1,0).left===1);
    A('护盾账本：消耗后扣减', shieldLedger(2,1).left===1);
    A('护盾账本：不会为负', shieldLedger(1,5).left===0);
    A('护盾账本：上限 3 枚', shieldLedger(99,0).left===3, shieldLedger(99,0).left);
    A('满 7 天才发第一枚', shieldShouldGrant(6,0)===false&&shieldShouldGrant(7,0)===true);
    A('已发过不重复发', shieldShouldGrant(7,1)===false);
    A('满 14 天可发第二枚', shieldShouldGrant(14,1)===true);
    A('发放数不超上限', shieldShouldGrant(999,3)===false);
    // 护住的日期不打断连续
    const DS = {
      '2026-10-24':{slots:[{status:'done',task:{title:'a'}}]},
      '2026-10-25':{slots:[{status:'expired',task:{title:'b'}}]},   // 断签
      '2026-10-26':{slots:[{status:'done',task:{title:'c'}}]},
    };
    A('无护盾时断签清零', computeStreak(DS,'2026-10-26')===1, computeStreak(DS,'2026-10-26'));
    A('有护盾时连续保住', computeStreak(DS,'2026-10-26',['2026-10-25'])===3, computeStreak(DS,'2026-10-26',['2026-10-25']));
    A('护盾只影响指定日期', computeStreak(DS,'2026-10-26',['2026-10-20'])===1);
  }

  /* ── 低谷庇护 ── */
  {
    const mk = (done) => ({slots: done>0
      ? Array.from({length:done},()=>({status:'done',task:{title:'x'}}))
      : [{status:'expired',task:{title:'x'}}]});
    // 注意：troughDepth 从「昨天」起算，当天不算（当天还没过完）
    A('昨天有完成不算低谷', troughDepth({'2026-10-25':mk(1),'2026-10-26':mk(0)},'2026-10-26')===0);
    A('连续 1 天零完成不算低谷', troughDepth({'2026-10-25':mk(0),'2026-10-26':mk(1)},'2026-10-26')===1);
    A('连续 2 天零完成 → 低谷', troughDepth({'2026-10-24':mk(0),'2026-10-25':mk(0),'2026-10-26':mk(1)},'2026-10-26')===2);
    A('低谷判定布尔值', inTrough({'2026-10-24':mk(0),'2026-10-25':mk(0),'2026-10-26':mk(1)},'2026-10-26')===true);
    A('昨天有完成则低谷结束', inTrough({'2026-10-24':mk(0),'2026-10-25':mk(1),'2026-10-26':mk(0)},'2026-10-26')===false);
    A('当天零完成不影响低谷判定', troughDepth({'2026-10-24':mk(0),'2026-10-25':mk(0),'2026-10-26':mk(0)},'2026-10-26')===2,
      troughDepth({'2026-10-24':mk(0),'2026-10-25':mk(0),'2026-10-26':mk(0)},'2026-10-26'));
    // 系统没运行的日子不算偷懒
    A('跳过无记录的天', troughDepth({'2026-10-23':mk(0),'2026-10-25':mk(0),'2026-10-26':mk(1)},'2026-10-26')===2,
      troughDepth({'2026-10-23':mk(0),'2026-10-25':mk(0),'2026-10-26':mk(1)},'2026-10-26'));
    A('窗口没开过的天不算', troughDepth({'2026-10-24':{slots:[]},'2026-10-25':mk(0),'2026-10-26':mk(1)},'2026-10-26')===1,
      troughDepth({'2026-10-24':{slots:[]},'2026-10-25':mk(0),'2026-10-26':mk(1)},'2026-10-26'));
  }

  console.log(ok?'%c[growth] 自检全部通过 ✓':'[growth] 自检存在失败项', ok?'color:#1F7A5C':'color:#B3554D');
  return ok;
}
