'use strict';
/* engine.js — 结算引擎与动作：打开面板补发布、到点失效、完成/放弃/兑换。
   依赖：core.js、state.js（S/save/log）、ai.js（callAI）。
   渲染通过 window.UI 钩子（ui.js 定义），避免模块循环依赖。 */

let generating=false;
const sl_kind_cn = k => k==='burst'?'突发限时':'支线';

/* 记一条补救事件：今日页顶部说明条的数据源。一天里可能补救多次（分批回来），所以累加。 */
function noteRescue(dayRec, kind, gapMin, nowMs){
  const r = dayRec.rescue = dayRec.rescue || { at:nowMs, n:0, gapMin:0, side:0, burst:0, grace:0 };
  r.at = nowMs;
  r.gapMin = Math.max(r.gapMin||0, Math.round(gapMin||0));
  r.n = (r.n||0) + 1;
  if(kind) r[kind] = (r[kind]||0) + 1;
}

async function settle(){
  const today = ds(new Date());
  if(!S.days[today]) S.days[today] = { slots: planDay(today, S.created, {start:S.settings.dayStart,end:S.settings.dayEnd})
    .map(p=>({...p, status:'waiting', task:null, issuedAt:0, deadline:0})), tzOffset:-new Date().getTimezoneOffset() };
  let dirty=false;  // 必须在任何 dirty=true 之前声明（曾因后置声明触发 TDZ，整轮结算静默失败）
  // 每日快照（数据页成长曲线的数据源），变化时才落盘
  const snap = { attrs:{...S.player.attrs}, level:S.player.level, exp:S.player.exp };
  const prevSnap = S.days[today].snap;
  if(!prevSnap || JSON.stringify(prevSnap)!==JSON.stringify(snap)){ S.days[today].snap=snap; dirty=true; }

  const now = Date.now();

  // 心跳：只有面板"真的被看着"才算提醒有人接收（后台标签、最小化窗口都算离开）。
  // 心跳存在独立键里，不进存档——见 state.js 的 lastSeenAt/markSeen 说明。
  const visible = typeof document==='undefined' || !document.visibilityState || document.visibilityState==='visible';
  const prevSeen = lastSeenAt();
  const offline = isOffline(prevSeen, now);
  const gapMin = Math.round(offlineGapMin(prevSeen, now));
  if(visible) markSeen(now);
  const dayRec = S.days[today];

  // 往日未完成任务 → 失效。宽限期 GRACE_MS 内保留（补交窗口），否则系统休眠一夜就全军覆没。
  const tzNow = -new Date().getTimezoneOffset();
  const GRACE_MS = 2*3600*1000;
  for(const d of Object.keys(S.days)){
    if(d>=today) continue;
    // 跨时区/改系统时间：保留已完成槽位，未发布的按新时区重排（发布时刻是"当日分钟数"，会失配）
    if(S.days[d].tzOffset!==undefined && tzNow!==S.days[d].tzOffset){
      S.days[d].slots = S.days[d].slots.filter(sl=>sl.status!=='waiting');
      S.days[d].tzOffset = tzNow; dirty=true;
    }
    for(const sl of S.days[d].slots){
      if(sl.status!=='pending' || !sl.task) continue;
      if(now - sl.deadline < GRACE_MS){ dirty=true; continue; }  // 宽限期内：留给宿主补交
      sl.status='expired'; S.stats.expired++; dirty=true;
      log(`检测到逾期任务「${sl.task.title}」，系统已注销。宿主，机会不会一直等你。`,'bad');
    }
  }
  // 今日超时任务 → 失效。但如果它是在宿主离线期间到期的（离开时还活着、回来已经死了），
  // 给 2 小时补交窗口——这不是拖延，是没机会做。
  for(const sl of dayRec.slots){
    if(sl.status!=='pending' || !sl.task || now < sl.deadline) continue;
    if(offline && sl.deadline > prevSeen){
      sl.deadline = now + GRACE_MS; sl.rescued = 'grace'; dirty = true;
      noteRescue(dayRec, 'grace', gapMin, now);
      log(`任务「${sl.task.title}」在宿主离线期间到期，系统给了 2 小时补交窗口。`,'up');
      continue;
    }
    sl.status='expired'; S.stats.expired++; dirty=true;
    log(`任务「${sl.task.title}」超出时限，已失效。`,'bad');
  }
  // 待发布槽位：到点的按「有没有人接收过提醒」决定处置——
  // 在线却拖过 2 小时的突发仍按原规则收回；离线期错过的则补救（重新计时/救回一次）。
  const need=[];               // [{sl, d}] d = rescueDecision 的结果
  const nowM = nowMin();
  let rescueLeft = Math.max(0, RESCUE_PER_DAY - (dayRec.rescueCount||0));
  for(const sl of dayRec.slots){
    if(sl.status!=='waiting' || sl.at>nowM) continue;
    const d = rescueDecision(sl, { nowMs:now, nowMinVal:nowM, dayStr:today, offline, rescueLeft });
    if(d.action==='void'){
      // 状态一旦设为 void，下一轮循环的 `status!=='waiting'` 就会跳过它，
      // 所以这里天然只执行一次，无需额外的 notified 标志（原来的标志是死代码）。
      sl.status='void'; sl.voidReason=d.reason||'ignored'; dirty=true;
      if(d.reason==='budget'){
        log(`突发任务 ${hm(sl.at)} 触发，宿主离线错过。今日的补救额度已用尽，系统收回（奖励 ×2 已消失）。`,'bad');
        window.UI?.toast?.(`又错过一个突发任务（${hm(sl.at)}，当日补救额度已用完）`,'red');
      }else{
        log(`一个突发任务在 ${hm(sl.at)} 触发，但宿主未在 2 小时内响应，系统已收回（奖励 ×2 的机会溜走了）。`,'bad');
        window.UI?.toast?.(`错过一个突发任务（${hm(sl.at)} 触发，×2 奖励已收回）`,'red');
      }
      continue;
    }
    if(d.cost) rescueLeft -= d.cost;
    need.push({sl, d});
  }
  // 补交拉力：窗口过半仍零完成时，追加一个轻量起步任务（不走 AI，保证立刻可见）
  if(!dayRec.starter && needsStarterTask(dayRec, nowMin(), {start:S.settings.dayStart,end:S.settings.dayEnd})){
    const pool = FALLBACK_POOL.filter(t=>t.difficulty===1 && t.minutes<=15);
    // 与普通任务一样避开近期出现过的标题，否则起步任务天天是同一两个
    const hist = titleHistory(S.days, today);
    const todayUsed = new Set(dayRec.slots.filter(x=>x.task).map(x=>x.task.title));
    const pick = pickFreshTemplate(pool, hist, todayUsed, rngFor(today+'|starter')) || FALLBACK_POOL[0];
    const slot = { at: nowMin(), kind:'side', starter:true, status:'pending', issuedAt:Date.now(),
      // 截止夹到当天结束：深夜窗口（如 20:00–23:59）下 +2 小时会跨到次日，
      // 变成挂在昨天记录里、第二天还能完成的幽灵任务（突发任务早已这样夹过）
      task:{...pick, kind:'side'},
      deadline: Math.min(new Date(today+'T23:59:00').getTime(), Date.now()+120*60000) };
    dayRec.slots.push(slot);
    dayRec.starter = true;
    const r = rewards(slot.task);
    log(`宿主今日尚无进展，系统追加一个起步任务：「${slot.task.title}」（奖励 EXP+${r.exp} ◈+${r.coins} ${slot.task.category}+${r.attr}）。动起来就行。`,'up');
    dirty = true;
  }

  if(dirty) save();

  if(need.length && !generating){
    generating=true; window.UI?.renderTasks?.();
    try{
      const tasks = await callAI(need.length, need.map(x=>x.sl.kind));
      const fresh=[];
      need.forEach(({sl, d}, i)=>{
        const raw = tasks[i] || {...FALLBACK_POOL[i%FALLBACK_POOL.length], kind:sl.kind};
        // 稀有度：同日同槽位确定性掷骰，重开页面不会"换掉"已发布的稀有度
        const t = {...raw, rarity: raw.rarity || rollRarity(rngFor(today+'|rar|'+sl.at+'|'+i))};
        // 来源标记：池内任务被采用 vs AI 自拟。没有这个就无法回答"任务池到底有没有用"
        t.fromPool = isFromPool(t, S.taskPool);
        sl.task=t; sl.status='pending'; sl.issuedAt=Date.now();
        // 截止时刻由 rescueDecision 决定：补救过的按"看到的那一刻"起算，而不是发布时刻
        sl.deadline = d.deadline;
        if(d.tag) sl.rescued = d.tag;                 // UI 打「补时 / 救回」徽标
        if(d.cost) dayRec.rescueCount = (dayRec.rescueCount||0) + 1;
        const r=rewardsWithRarity(t);
        fresh.push({t, r, sl, d});
      });
      save();
      fresh.forEach(({t,r,d})=>{
        const tag = t.rarity && t.rarity!=='common' ? `【${RARITY[t.rarity].name}】` : '';
        log(`叮！系统发布${sl_kind_cn(t.kind)}任务${tag}：「${t.title}」 奖励：EXP+${r.exp} ◈${r.coins} ${t.category}+${r.attr}${t.kind==='burst'?'（限时×2）':''}`);
        if(d.tag==='burst') log(`✦ 补救：宿主离线期间错过的突发任务已救回，限时重新计时至 ${new Date(d.deadline).toTimeString().slice(0,5)}（当日仅 ${RESCUE_PER_DAY} 次）。`,'up');
        else if(d.tag==='side') log(`⏱ 补救：「${t.title}」的发布时刻在宿主离线期间，截止已按此刻重新计时至 ${new Date(d.deadline).toTimeString().slice(0,5)}。`,'up');
      });
      // 本轮错过的提醒：记在当天，UI 顶部给一条「补时」说明（否则用户只看到任务凭空多了两个）
      const rescued = fresh.filter(x=>x.d.tag);
      if(rescued.length){
        rescued.forEach(x=>noteRescue(dayRec, x.d.tag, gapMin, Date.now()));
        save();
        window.UI?.toast?.(`补救 ${rescued.length} 个错过的发布时刻，已重新计时`,'gold');
      }
      window.UI?.ding?.(fresh.some(x=>x.t.kind==='burst'));
      if(fresh.length>1) window.UI?.toast?.(`系统发布了 ${fresh.length} 个新任务`);
      else window.UI?.toast?.(`叮！新任务：${fresh[0].t.title}`);
    }catch(err){
      // 任何意外都不能让 generating 永久卡住（否则界面永远停在"推演中"，任务彻底停发）
      console.error('[growth] 任务生成失败：', err);
      window.UI?.toast?.('任务生成异常，已跳过本轮，稍后自动重试','red');
    }finally{
      generating=false;
      window.UI?.renderTasks?.();   // 无论成败都要把界面从"推演中"里放出来
    }
  }
}

/* 完成一次任务结算：所有状态迁移走同一守卫，保证幂等（双击/双开/未来加异步都不会双发奖励）。
   分段推进：partial（已领半奖）→ done 时只补发另一半；pending 直接 done 则发全奖。
   奖励链路：基础公式 → 稀有度加成 → 当日赐福倍率。 */
function completeTask(dayStr, idx, note){
  if(completeTask._busy) return;
  completeTask._busy=true;
  try{
    const sl=S.days[dayStr]?.slots[idx];
    if(!sl||!sl.task||(sl.status!=='pending'&&sl.status!=='partial')) return;
    // 刚发布的任务先冷却：卡片重排后「完成」按钮会移位，实测出现过发布 3 秒就被点掉。
    // 只拦"确实刚发布"的（age>=0）；系统时间被改小导致 issuedAt 在未来的，不拦。
    const age = Date.now() - (sl.issuedAt||0);
    if(sl.issuedAt && age >= 0 && age < COMPLETE_COOLDOWN_MS){
      window.UI?.toast?.(`这条任务刚发布 ${Math.ceil((COMPLETE_COOLDOWN_MS-age)/1000)} 秒，先看清再打卡`,'red');
      return;
    }
    // 撤销快照：整份存档深拷贝，误点后原样回滚（奖励/主线/成就/连锁一并退掉）
    const snapshot = JSON.stringify(S);
    const wasPartial = sl.status==='partial';
    sl.status='done';
    sl.settledAt=Date.now();
    if(note) sl.note=String(note).slice(0,60);
    const t=sl.task;
    const p=S.player;

    // ① 基础（含稀有度）→ ② 当日赐福倍率
    const base = wasPartial ? halfRewards(t) : rewardsWithRarity(t);
    const mult = blessingMult(blessingFor(dayStr, S.created), t.category);
    const r = {
      exp:  Math.round(base.exp  * (wasPartial?1:mult)),
      coins:Math.round(base.coins* (wasPartial?1:mult)),
      attr: Math.round(base.attr * (wasPartial?1:mult)),
    };
    const attrBefore = p.attrs[t.category] || 0;
    p.exp+=r.exp; p.coins+=r.coins; p.attrs[t.category]=attrBefore + r.attr;
    S.stats.done++;

    const rar = RARITY[t.rarity] || RARITY.common;
    const tone = TONES[S.settings.tone] || TONES[DEFAULT_TONE];
    const rarTxt = t.rarity && t.rarity!=='common' ? `【${rar.name}任务】` : '';
    log(`${rarTxt}任务「${t.title}」${wasPartial?'剩余部分也完成了':'完成'}！奖励发放：EXP+${r.exp} ◈+${r.coins} ${t.category}+${r.attr}${mult>1?`（赐福 ×${mult}）`:''}${sl.note?` 宿主记录：${sl.note}`:''} ${tone.done}`,'good');
    while(p.exp>=expToNext(p.level)){
      p.exp-=expToNext(p.level); p.level++;
      log(`⬆ 等级提升！宿主当前等级 Lv.${p.level}`,'up');
      window.UI?.toast?.(`等级提升！Lv.${p.level}`,'gold'); window.UI?.ding?.(true);
    }
    // 属性跨级：这是被忽略的高光时刻——数字一直在涨，但越过 D/C/B 线时没有任何仪式感
    announceRankUp(t.category, attrBefore, p.attrs[t.category]);
    if(t.rarity==='epic'){
      log(`✦✦ 系统公告：宿主完成了一项【史诗】任务 ——「${t.title}」。此等事迹，当记入档案。`,'up');
      window.UI?.toast?.('✦ 史诗任务达成！','gold');
    }
    window.UI?.toast?.(`+${r.exp} EXP  +${r.coins} 金币`,'gold'); window.UI?.ding?.(false);

    // 主线进度（只在整体完成时推进，半奖不算）
    if(!wasPartial){
      const mq = ensureMainQuest(S);
      const before = mq.progress;
      const res = progressMainQuest(mq, 1);
      if(res.progress !== before){
        if(res.milestone){
          log(`主线「${mq.title}」推进至里程碑 ${res.milestone}/${mq.target}。`,'up');
          window.UI?.toast?.(`主线里程碑：${res.milestone}/${mq.target}`,'gold');
        }
        if(res.justCompleted){
          p.coins += mq.rewardCoins; p.exp += mq.rewardExp;
          log(`🎉 主线任务「${mq.title}」完成！额外奖励 EXP+${mq.rewardExp} ◈+${mq.rewardCoins}。`,'up');
          window.UI?.toast?.(`主线完成：${mq.title}`,'gold');
        }
      }
      checkStreakBonus();
      maybeChain(t, dayStr);
    }

    grantAchievements();
    save(); window.UI?.renderAll?.();
    armUndo(snapshot, t.title);
  }finally{ completeTask._busy=false; }
}

/* ── 完成撤销 ──
   误点「完成」会连带发奖励、推主线、发连锁，手动逐项回退极易漏；
   这里直接回滚整份存档快照，几秒内可反悔。 */
let undoSnapshot=null, undoTimer=null;
function armUndo(snapshot, title){
  undoSnapshot = snapshot;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(()=>{ undoSnapshot=null; }, UNDO_WINDOW_MS);
  window.UI?.undo?.('「'+title+'」已完成', UNDO_WINDOW_MS);
}
function undoComplete(){
  if(!undoSnapshot) return window.UI?.toast?.('没有可撤销的操作','red');
  const snap = undoSnapshot; undoSnapshot=null; clearTimeout(undoTimer);
  // 就地覆盖而不是给 S 重新赋值：ui.js 里多处直接闭包引用 S
  for(const k of Object.keys(S)) delete S[k];
  Object.assign(S, JSON.parse(snap));
  save(); window.UI?.renderAll?.();
  window.UI?.toast?.('已撤销上一次完成，奖励与进度已回滚','gold');
}

/* 属性跨级播报：从 F→E→D→C→B→A→S 每次跨线都给一次系统公告 + 金色提示 */
function announceRankUp(cat, before, after){
  const up = rankUpgrade(before, after);
  if(!up) return;
  S.rankUps = S.rankUps || [];
  S.rankUps.unshift({ cat, rank:up.rank, value:after, t:Date.now() });
  S.rankUps = S.rankUps.slice(0,30);
  log(`✦ 属性突破！${cat} 达到 ${up.rank} 级（${up.name}）—— 当前 ${after}。`, 'up');
  window.UI?.toast?.(`${cat} 突破至 ${up.rank} 级 · ${up.name}`, 'gold');
  window.UI?.ding?.(true);
}

/* 连续签到阶梯奖励：连击达到 3/7/14/30 天时额外发金币（每档只领一次） */
function checkStreakBonus(){
  const today = ds(new Date());
  const streak = computeStreak(S.days, today);
  S.streakClaimed = S.streakClaimed || [];
  const bonus = streakBonus(streak, S.streakClaimed);
  if(!bonus) return;
  S.streakClaimed.push(bonus.need);
  S.player.coins += bonus.coins;
  log(`🔥 连续 ${streak} 天！达成「${bonus.need} 日之约」，额外奖励 ◈+${bonus.coins}。`,'up');
  window.UI?.toast?.(`连续 ${streak} 天！+${bonus.coins} 金币`,'gold');
  window.UI?.ding?.(true);
}

/* 连锁任务：智力/自律类任务完成后有概率派生一个后续任务。
   模板从内置池里挑，但要避开近 7 天（含今天）出现过的标题——池子只有十几条时，
   不加避让会天天派生出同一个任务（存档里出现过连续几天「清空一个收藏夹」「快速整理」）。
   近期都用过时退到最久没出现的那条；连"今天没用过"都满足不了就不发，绝不制造重名任务。 */
function maybeChain(task, dayStr){
  if(!shouldChain(task, rngFor(dayStr+'|chain|'+Date.now()))) return;
  const rec = S.days[dayStr];
  if(!rec) return;
  const hist = titleHistory(S.days, dayStr);
  const todayUsed = new Set(rec.slots.filter(x=>x.task).map(x=>x.task.title));
  const pool = FALLBACK_POOL.filter(x=>x.category===task.category && x.difficulty<=task.difficulty);
  const pick = pickFreshTemplate(pool, hist, todayUsed, rngFor(String(Date.now())));
  if(!pick) return;
  rec.slots.push({
    at: nowMin(), kind:'side', chainedFrom:task.title, status:'pending',
    issuedAt:Date.now(), task:{...pick, kind:'side'},
    deadline: Math.min(new Date(dayStr+'T23:59:00').getTime(), Date.now()+180*60000),
  });
  log(`⟳ 连锁反应：完成「${task.title}」后，系统追加了后续任务「${pick.title}」。`,'up');
  window.UI?.toast?.(`连锁任务出现：${pick.title}`,'gold');
}


/* 分段推进第一步：领一半奖励，任务进入 partial，可继续完成剩余部分 */
function startPartial(dayStr, idx){
  if(completeTask._busy) return;
  const sl=S.days[dayStr]?.slots[idx];
  if(!sl||sl.status!=='pending'||!sl.task) return;
  if(!canSplit(sl.task)) return window.UI?.toast?.('这个任务太短，一口气做完更划算','red');
  if(!confirm(`先做一部分，领取一半奖励？\n完成后记得回来收尾，否则剩余奖励会随任务失效。`)) return;
  completeTask._busy=true;
  try{
    const t=sl.task, h=halfRewards(t), p=S.player;
    sl.status='partial';
    sl.partialAt=Date.now();
    const before2 = p.attrs[t.category] || 0;
    p.exp+=h.exp; p.coins+=h.coins; p.attrs[t.category]=before2 + h.attr;
    log(`宿主先完成了一部分「${t.title}」，系统预付半奖：EXP+${h.exp} ◈+${h.coins} ${t.category}+${h.attr}。剩余部分请记得收尾。`,'good');
    window.UI?.toast?.(`已领半奖：+${h.exp} EXP  +${h.coins} 金币`,'gold');
    announceRankUp(t.category, before2, p.attrs[t.category]);
    grantAchievements();
    save(); window.UI?.renderAll?.();
  }finally{ completeTask._busy=false; }
}

/* 成就检查：在完成/半奖之后调用，新解锁的写进存档并发公告 */
function grantAchievements(){
  if(!S.achievements) S.achievements=[];
  const fresh = checkAchievements(S);
  if(!fresh.length) return;
  for(const id of fresh){
    S.achievements.push(id);
    const a = ACHIEVEMENTS.find(x=>x.id===id);
    if(a){
      log(`🏆 成就解锁「${a.name}」—— ${a.desc}`,'up');
      window.UI?.toast?.(`🏆 成就解锁：${a.name}`,'gold');
    }
  }
  window.UI?.ding?.(true);
}

function abandonTask(dayStr, idx){
  const sl=S.days[dayStr]?.slots[idx];
  if(!sl||(sl.status!=='pending'&&sl.status!=='partial')) return;
  if(!confirm(`放弃任务「${sl.task.title}」？没有惩罚，但系统会记下这次失信。${sl.status==='partial'?'（已领的半奖不收回）':''}`)) return;
  sl.status='expired'; sl.settledAt=Date.now(); S.stats.expired++;
  log(`宿主放弃了任务「${sl.task.title}」。系统已记录。`,'bad');
  save(); window.UI?.renderAll?.();
}

function buyItem(i){
  const it=S.shop[i]; if(!it) return;
  if(S.player.coins<it.cost) return window.UI?.toast?.('金币不足，先去做任务，宿主。','red');
  if(!confirm(`消耗 ${it.cost} 金币兑换「${it.name}」？`)) return;
  S.player.coins-=it.cost;
  log(`兑换成功：「${it.name}」（-${it.cost} 金币）。宿主，请兑现对自己的承诺。`,'good');
  save(); window.UI?.renderAll?.();
}
