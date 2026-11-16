'use strict';
/* ui.js — 渲染与交互：所有 DOM 操作集中在此。
   依赖：core.js（工具/公式/dayStats/computeStreak）、state.js（S/save/log）、engine.js（动作）。 */

const $ = id => document.getElementById(id);
let reportBusy=false;
let showDone=false;   // 今日页「已完成」折叠状态：跨重渲染保留（每次结算都会重画）

/* ── 提示 / 音效 ── */
function toast(txt, cls=''){
  const zone=$('toastZone');
  const d=document.createElement('div'); d.className='toast '+cls; d.textContent=txt;
  zone.appendChild(d);
  // 上限 3 条：连续事件（结算+发任务+跨级）叠满时，多余的会糊住整屏内容
  while(zone.children.length>3) zone.firstElementChild.remove();
  setTimeout(()=>d.remove(), 3400);
}

/* 撤销条：完成操作后几秒内可反悔。toast 是纯文本，这里单独做一个带按钮的。 */
let undoBar=null;
function undo(text, ms){
  const zone=$('toastZone');
  if(undoBar){ undoBar.remove(); undoBar=null; }
  const d=document.createElement('div');
  d.className='toast gold undo-toast';
  const span=document.createElement('span'); span.textContent=text;
  const btn=document.createElement('button');
  btn.className='btn btn-sm'; btn.textContent='撤销'; btn.dataset.act='undo';
  d.appendChild(span); d.appendChild(btn);
  zone.appendChild(d); undoBar=d;
  while(zone.children.length>3) zone.firstElementChild.remove();
  setTimeout(()=>{ if(undoBar===d) undoBar=null; d.remove(); }, ms||UNDO_WINDOW_MS);
}
function ding(up){
  if(!S.settings.sound) return;
  try{
    const a=new (window.AudioContext||window.webkitAudioContext)();
    const play=(f,t0)=>{ const o=a.createOscillator(),g=a.createGain();
      o.connect(g); g.connect(a.destination); o.type='sine'; o.frequency.value=f;
      g.gain.setValueAtTime(.12,a.currentTime+t0); g.gain.exponentialRampToValueAtTime(.001,a.currentTime+t0+.45);
      o.start(a.currentTime+t0); o.stop(a.currentTime+t0+.5); };
    play(880,0); if(up) play(1320,.18);
  }catch(e){}
}

/* ── 今日页 ── */
function greet(){
  const h=new Date().getHours();
  return h<6?'夜深了':h<12?'上午好':h<18?'下午好':'晚上好';
}
function renderHero(){
  const p=S.player, need=expToNext(p.level);
  const today=ds(new Date()), day=S.days[today];
  const published=day?day.slots.filter(s=>s.status!=='waiting').length:0;
  const done=day?day.slots.filter(s=>s.status==='done').length:0;
  const pct= published? Math.round(done/published*100):0;
  const C=2*Math.PI*100;
  $('ringSeg').setAttribute('stroke-dasharray', `${C*pct/100} ${C}`);
  $('ringPct').textContent=pct+'%';
  $('ringCap').textContent= published?`今日成长环 ${done}/${published}`:'系统静默中';
  $('greeting').textContent=`${greet()}，${p.name}`;
  const days=Math.max(1, Math.ceil((Date.now()-S.created)/86400000));
  $('greetSub').textContent=`${new Date().getMonth()+1} 月 ${new Date().getDate()} 日 星期${'日一二三四五六'[new Date().getDay()]} · 系统运行第 ${days} 天`;
  $('hName').textContent=p.name;
  $('hLv').textContent='Lv.'+p.level;
  $('hExp').textContent=`${p.exp} / ${need} EXP`;
  $('hExpBar').style.width=Math.min(100,p.exp/need*100)+'%';
  $('hCoins').textContent=p.coins;
  // 称号：只显示已解锁且当前佩戴的
  const ttl = p.title && (S.achievements||[]).includes(p.title) ? titleOf(p.title) : null;
  $('hTitle').hidden = !ttl;
  if(ttl) $('hTitle').textContent = ttl;
  renderMainQuest();
  renderBlessing();
  $('hStats').textContent=`累计完成 ${S.stats.done} · 失效 ${S.stats.expired} · 常人均值 ${NORMAL_ATTR}／每维（灰线为基准）`;
  $('hAttrs').innerHTML=CATS.map(c=>{
    const v=p.attrs[c]||0, cap=Math.max(200, Math.ceil((Math.max(v,NORMAL_ATTR)+1)/100)*100);
    const dl=v-NORMAL_ATTR, dlTxt=(dl>=0?'+':'')+dl;
    const info=rankInfo(v), gap=nextRankGap(v);
    // 距下一级的分量：让"还差多少"可见，而不是只给一个不知道离多远的字母
    const gapTxt = gap ? `距 ${gap.next.rank} 还差 ${gap.need}` : '已达顶端';
    // 刚跨级的属性高亮（24 小时内），给一次视觉确认
    const recent=(S.rankUps||[]).some(r=>r.cat===c && Date.now()-r.t < 86400000);
    // 负号统一用 −（U+2212），比 ASCII 连字符更像减号，也不会挤着数字
    const dlShow = dl>=0 ? `+${dl}` : `−${Math.abs(dl)}`;
    return `<div class="attr${recent?' rank-up':''}"><div class="row"><span class="name">${c}</span>
      <span class="rank mono-num" style="color:var(--c-${c})" title="${info.name}">${v} ${info.rank}</span>
      <span class="dl" style="color:${dl>=0?'var(--accent-deep)':'var(--danger)'}">${dlShow}&nbsp;vs 常人</span></div>
      <div class="bar"><i style="width:${v/cap*100}%;background:var(--c-${c})"></i>
      <i class="normMark" style="left:${NORMAL_ATTR/cap*100}%" title="常人均值 ${NORMAL_ATTR}"></i></div>
      <div class="attr-gap">${info.name} · ${gapTxt}</div></div>`;
  }).join('');
}

/* ── 主线任务卡片 ── */
function renderMainQuest(){
  const q = ensureMainQuest(S);
  const pct = q.target ? Math.min(100, Math.round(q.progress/q.target*100)) : 0;
  $('mqTitle').textContent = `主线 · ${q.title}`;
  $('mqDesc').textContent = q.completed ? '已达成，系统记住了这段路。' : (q.desc||'');
  $('mqBar').style.width = pct+'%';
  $('mqNo').textContent = q.completed ? 'CLEARED' : 'MAIN QUEST';
  $('mqProg').textContent = `${q.progress} / ${q.target}`;
  const next = (q.milestones||[]).filter(m=>!(q.doneMilestones||[]).includes(m));
  $('mqMile').textContent = q.completed
    ? `完成奖励已发放：EXP+${q.rewardExp} ◈+${q.rewardCoins}`
    : (next.length ? `下一里程碑 ${next[0]}（还差 ${Math.max(0,next[0]-q.progress)} 个）` : '');
}

/* ── 今日赐福 ── */
function renderBlessing(){
  const b = blessingFor(ds(new Date()), S.created);
  const bar = $('blessingBar');
  if(!b || b.id==='none'){ bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = `✦ 今日赐福：<b>${esc(b.name)}</b> —— ${esc(b.desc)}`;
}

function taskCard(sl, idx, dayStr){
  const t=sl.task, r=sl.task?rewardsWithRarity(t):null;
  const kindBadge=`<span class="chip ${sl.kind==='burst'?'chip-burst':'chip-accent'}">${sl_kind_cn(sl.kind)}${sl.kind==='burst'?' ×2':''}</span>`;
  if(sl.status==='waiting') return '';
  if(sl.status==='void') return `<div class="task-card void"><div class="t-title">？？？（已收回的突发任务）${kindBadge}</div>
    <div class="t-desc">${sl.voidReason==='budget'
      ? `宿主离线错过，且当日补救额度（${RESCUE_PER_DAY} 次）已用尽，奖励与任务一同消失。`
      : '宿主未在 2 小时内响应，奖励与任务一同消失。'}</div></div>`;
  const cat=`<span class="chip cat-${t.category}">${t.category}</span>`;
  const starterBadge = sl.starter ? `<span class="chip chip-accent">起步</span>` : '';
  // 补救标记：这条任务是在宿主离线期间到点的，截止按"看到的那一刻"重算过
  const rescueLabel = { side:'重新计时', burst:'错过救回', grace:'补交窗口' }[sl.rescued];
  const rescueBadge = rescueLabel
    ? `<span class="chip ${sl.rescued==='burst'?'chip-burst':'chip-accent'}" title="发布/到期时刻在宿主离线期间，系统已补救">${rescueLabel}</span>` : '';
  // 稀有度徽标（普通不显示，避免视觉噪音）
  const rarBadge = t.rarity && t.rarity!=='common'
    ? `<span class="chip chip-${t.rarity}">${RARITY[t.rarity].name}</span>` : '';
  // 连锁任务的来源标注
  const chainBadge = sl.chainedFrom ? `<span class="chip chip-rare">连锁</span>` : '';
  // 补交：往日任务仍在 2 小时宽限期内（engine 保留为 pending），标注出来免得以为系统忘了
  const liveStatus = sl.status==='pending'||sl.status==='partial';
  const isOverdue = sl.deadline && Date.now()>sl.deadline;
  const lateBadge = isOverdue && liveStatus
    ? `<span class="chip chip-burst">逾期待补交</span>` : '';
  const partialBadge = sl.status==='partial' ? `<span class="chip chip-accent">已领半奖</span>` : '';
  const cd = liveStatus && sl.deadline && !isOverdue
    ? `<span class="cd" data-deadline="${sl.deadline}">${fmtRemain(sl.deadline)}</span>`
    : (isOverdue && liveStatus ? `<span class="cd over">已超时，仍可补交</span>` : '');
  const st = {pending:'',partial:'',done:'已完成 ✓',expired:'已失效'}[sl.status];
  // 新任务冷却：发布后 60 秒内「完成」不可点（防止卡片重排导致的误点）。
  // 倒计时由 app.js 的秒级 ticker 更新，不靠重渲染。
  const doneLabel = sl.status==='partial' ? '完成剩余' : '完成';
  const armAt = sl.issuedAt ? sl.issuedAt + COMPLETE_COOLDOWN_MS : 0;
  const coolLeft = armAt ? Math.ceil((armAt - Date.now())/1000) : 0;
  const doneBtn = coolLeft > 0
    ? `<button class="btn btn-sm btn-primary" disabled data-day="${dayStr}" data-i="${idx}" data-arm="${armAt}" data-label="${doneLabel}">完成（${coolLeft}s）</button>`
    : `<button class="btn btn-sm btn-primary" data-act="done" data-day="${dayStr}" data-i="${idx}">${doneLabel}</button>`;
  // 分段推进：长任务给出「先做一部分」
  const splitBtn = sl.status==='pending' && canSplit(t)
    ? `<button class="btn btn-sm" data-act="partial" data-day="${dayStr}" data-i="${idx}">先做 10 分钟</button>` : '';
  const rwText = sl.status==='partial'
    ? `剩余奖励 EXP+${halfRewards(t).exp} ◈+${halfRewards(t).coins} ${t.category}+${halfRewards(t).attr}`
    : `奖励 EXP+${r.exp} ◈+${r.coins} ${t.category}+${r.attr}`;
  return `<div class="task-card ${sl.status}${isOverdue&&liveStatus?' late':''}">
    <div class="t-title">${esc(t.title)}${kindBadge}${rarBadge}${chainBadge}${cat}${starterBadge}${partialBadge}${rescueBadge}${lateBadge}</div>
    <div class="t-desc">${esc(t.desc)}</div>
    <div class="t-meta">
      <span>难度 ${'★'.repeat(t.difficulty)}</span><span>约 ${t.minutes} 分钟</span>
      <span class="rw">${rwText}</span>
      ${cd?`<span>${cd}</span>`:`<span>${st}</span>`}
    </div>
    ${liveStatus?`<div class="t-actions">
      <input class="note-in" data-note placeholder="${sl.status==='partial'?'收尾记录（可选）':'一句话记录这次完成（可选）'}">
      ${doneBtn}
      ${splitBtn}
      <button class="btn btn-sm btn-quiet" data-act="abandon" data-day="${dayStr}" data-i="${idx}">放弃</button>
    </div>`:''}
  </div>`;
}

function renderTasks(){
  const today=ds(new Date()), day=S.days[today];
  const box=$('taskList');
  if(generating){
    box.innerHTML=`<div class="empty">⬡ 系统推演中，正在为宿主生成任务…</div>`;
    $('tProgress').textContent=''; return;
  }
  if(!day){ box.innerHTML=''; $('tProgress').textContent=''; return; }
  const parts=[];
  const finished=[];   // 已完成/已失效/已收回，折叠显示
  // 错过提醒的补救说明：否则用户只会看到任务凭空多了几个、时限还莫名其妙比别人宽
  const rs = day.rescue;
  const quota = rescueQuota(day);
  if(rs && rs.n){
    const when = rs.gapMin >= OFFLINE_GAP_MIN ? `检测到你离开了约 ${fmtGap(rs.gapMin)}` : '面板这段时间没有运行';
    const what = [
      rs.side ? `${rs.side} 个支线的截止按此刻重新计时` : '',
      rs.burst ? `${rs.burst} 个突发任务已救回` : '',
      rs.grace ? `${rs.grace} 个在离线期间到期的任务给了补交窗口` : '',
    ].filter(Boolean).join('，');
    parts.push(`<div class="rescue-note">⬡ ${when}，有 ${rs.n} 个任务错过了提醒，已补救：${what}。
      <br>补救只改截止时刻，任务与奖励不变。</div>`);
  }
  // 救回额度常驻显示：额度耗尽前它原本完全隐形，用户只有「错过且用光」时才知道，
  // 那时已经没有余地了。今天有突发任务时就把状态摆出来。
  const hasBurst = day.slots.some(sl=>sl.kind==='burst');
  if(hasBurst || quota.used>0){
    const dots = Array.from({length:quota.total},(_,i)=>
      `<i class="qdot${i<quota.used?' used':''}"></i>`).join('');
    parts.push(`<div class="quota-note${quota.exhausted?' out':''}">
      <span>⬡ 今日突发救回额度 <b>${quota.left}/${quota.total}</b></span>
      <span class="qdots">${dots}</span>
      <span class="q-hint">${quota.exhausted
        ? '已用完 · 今天再错过突发任务将直接收回'
        : '仅「离线且已超 2 小时」的突发任务消耗额度'}</span></div>`);
  }
  // 逾期待补交的往日任务一并列出（否则界面看不到、也无从补交）
  const overdue=[];
  for(const d of Object.keys(S.days).sort().reverse()){
    if(d>=today) continue;
    S.days[d].slots.forEach((sl,i)=>{
      if((sl.status==='pending'||sl.status==='partial') && sl.task && Date.now()>sl.deadline) overdue.push([d,i]);
    });
  }
  overdue.forEach(([d,i])=>parts.push(taskCard(S.days[d].slots[i], i, d)));
  if(overdue.length) parts.push(`<div class="empty">⬡ 以上 ${overdue.length} 个任务已过时限，系统给了最后 2 小时补交窗口，抓紧。</div>`);
  for(let i=0;i<day.slots.length;i++){
    const sl=day.slots[i];
    if(sl.status==='waiting') continue;
    // 已完成/已失效：默认折起来，免得一天的记录把待办挤到屏幕外
    // （收回的突发任务不折：那条卡本身就是在解释"为什么没了"，藏起来等于没解释）
    if(sl.status==='done'||sl.status==='expired'){ finished.push([sl,i]); continue; }
    parts.push(taskCard(sl,i,today));
  }
  if(finished.length){
    parts.push(`<div class="done-toggle" data-act="toggleDone">${showDone?'▴ 收起':'▾ 展开'} 已完成 / 已失效 ${finished.length} 个</div>`);
    if(showDone) finished.forEach(([sl,i])=>parts.push(taskCard(sl,i,today)));
  }
  const waiting=day.slots.filter(s=>s.status==='waiting').length;
  if(waiting){
    // 已经有任务在手上时，这句话只是"还有 N 个在路上"，一句话够了；
    // 一条任务都没有时（访客第一次打开最可能撞上的画面），得把机制讲清楚，
    // 否则看起来像坏掉的空页面。
    const hasLive = day.slots.some(sl=>sl.status==='pending'||sl.status==='partial');
    if(hasLive){
      parts.push(`<div class="empty">系统静默中 —— 今日还有 ${waiting} 个任务未发布，时刻不定，保持警惕。</div>`);
    }else{
      const nextAt = day.slots.filter(sl=>sl.status==='waiting').map(sl=>sl.at).sort((a,b)=>a-b)[0];
      const hint = nextAt!==undefined && nextAt>nowMin()
        ? `下一个最晚 ${hm(nextAt)} 前后出现`
        : '随时可能出现';
      parts.push(`<div class="empty">⏳ 系统正在蓄势 —— 今日 ${waiting} 个任务尚未发布。<br>`
        + `任务按不定时发布（${hint}），不是坏了。<br>`
        + `<span class="muted">这条规则本身是设计的一部分：真实生活里，机会也不会提前通知你。</span></div>`);
    }
  }
  const doneN=day.slots.filter(s=>s.status==='done').length, totalN=day.slots.filter(s=>s.status!=='waiting').length;
  $('tProgress').textContent=`今日 ${doneN}/${totalN}`;
  box.innerHTML = parts.join('') || `<div class="empty">今日窗口尚未开启，系统静默中。</div>`;
  const pending=day.slots.filter(s=>s.status==='pending'||s.status==='partial').length + overdue.length;
  const badge=$('navToday');
  badge.hidden=!pending; badge.textContent=pending;
}

/* ── 商城 / 公告 ── */
function renderShop(){
  $('shopList').innerHTML = S.shop.length ? S.shop.map((it,i)=>{
    const pr = shopProgress(S.player.coins, it.cost);
    const cls = pr.pct>=100 ? 'ok' : '';
    return `<div class="shop-item"><span class="n">${esc(it.name)}</span>
      <span class="cost">◈ ${it.cost}</span>
      <button class="btn btn-sm" data-act="buy" data-i="${i}">兑换</button>
      <button class="btn btn-sm btn-quiet" data-act="shopDel" data-i="${i}">✕</button>
      <div class="shop-prog ${cls}"><i style="width:${pr.pct}%"></i></div>
      <div class="shop-note">${pr.pct>=100 ? '金币已足够，随时可兑换' : `还差 ${pr.need} 金币（约 ${pr.tasks} 个 ★★ 任务）`}</div>
    </div>`;
  }).join('')
    : `<div class="empty">商城空空如也。上架一个真实的奖励犒劳自己。</div>`;
}
function renderLog(){
  $('logList').innerHTML = S.log.slice(0,80).map(e=>
    `<div class="log-row ${e.kind}"><time>${new Date(e.t).toTimeString().slice(0,5)}</time><span>${esc(e.txt)}</span></div>`).join('')
    || '<div class="log-row sys"><time>--:--</time><span>系统已激活，等待为宿主发布第一个任务……</span></div>';
}

/* ── 复盘对话（数据页）：localStorage 独立键，带清空按钮 ── */
let reviewChatBusy=false;
let reviewOffline=false;   // 最近一次请求遇到网关离线：卡片挂常驻提示条；成功后自动解除
let reviewChat=[];         // {role:'user'|'assistant', text}

function chatMessageHTML(m){
  const cls = m.role==='user' ? 'me' : (m.local ? 'sys error' : 'sys');
  const who = m.role==='user' ? '宿主' : '系统';
  return `<div class="chat-msg ${cls}"><span class="who">${who}</span>
    <span class="chat-txt">${esc(m.text).replace(/\n/g,'<br>')}</span></div>`;
}

function renderReviewChat(){
  const box=$('chatBox');
  if(!box || !$('chatClearBtn')) return;
  // 请求进行中不重建：30 秒一轮的结算渲染会把「推演中」挂起气泡抹掉
  if(reviewChatBusy){ applyChatOffline(); return; }
  reviewChat = loadReviewChat();
  if(!reviewChat.length){
    box.innerHTML = `<div class="chat-empty">还没有对话。周报看完有疑问，就直接问——比如「这周为什么失效这么多」。</div>`;
  }else{
    box.innerHTML = reviewChat.map(chatMessageHTML).join('');
    box.scrollTop = box.scrollHeight;
  }
  $('chatClearBtn').hidden = !reviewChat.length;
  applyChatOffline();
}

/* 离线状态的可视化：卡片上的常驻提示条。输入保持可用——链路恢复后直接重试即可，
   禁用输入反而会把已经想好的问题卡在界面外。 */
function applyChatOffline(){
  const off=$('chatOffline'); if(off) off.hidden = !reviewOffline;
}

function setChatSending(on){
  reviewChatBusy=on;
  $('chatSendBtn').disabled = on;
  $('chatInput').disabled = on;
  $('chatSendBtn').textContent = on ? '推演中…' : '发送';
}

/* 发送一轮追问。历史先入列表再调用，本轮提问已在上下文里。 */
async function sendReviewChat(text){
  if(reviewChatBusy) return;
  text = (text!==undefined ? text : $('chatInput').value).trim();
  if(!text) return toast('先写下要追问的内容','red');
  reviewChat.push({role:'user', text});
  saveReviewChat(reviewChat);
  const box=$('chatBox');
  box.insertAdjacentHTML('beforeend', chatMessageHTML({role:'user', text}));
  $('chatInput').value='';
  box.scrollTop = box.scrollHeight;
  setChatSending(true);
  // 挂起气泡：chat() 最多重试一次，最坏 2×20s，给个明确的状态而不是界面卡住
  const pending=document.createElement('div');
  pending.className='chat-msg sys pending';
  pending.innerHTML=`<span class="who">系统</span><span class="chat-txt">⬡ 系统推演中…</span>`;
  box.appendChild(pending);
  box.scrollTop = box.scrollHeight;
  try{
    // 上下文 = 最近 ~10 条对话（含本轮提问）+ 指标 JSON + 周报正文 + 完成凭证。
    // reviewChat 已含本轮提问，整体传入；离线标记不拦截——网关挂了会快速失败并再次降级，
    // 拦住反而让链路恢复后无法自愈。
    const res = await callReviewChat(reviewChat);
    pending.remove();
    if(res.source==='offline'){
      reviewOffline=true;
      applyChatOffline();
      toast('网关离线，已用本地统计临时作答','red');
      // 本地降级回复入库：既给出基于真实数字的回答，30 秒一轮的自动重渲染也不会把它刷掉
      const local = reviewLocalReply();
      reviewChat.push({role:'assistant', text:local, local:true});
      saveReviewChat(reviewChat);
      box.insertAdjacentHTML('beforeend', chatMessageHTML({role:'assistant', text:local, local:true}));
      box.scrollTop = box.scrollHeight;
      // 提问已保留在历史里：网络恢复后不用重新打字，直接重发即可
      return;
    }
    reviewOffline=false;
    applyChatOffline();
    reviewChat.push({role:'assistant', text:res.text});
    saveReviewChat(reviewChat);
    box.insertAdjacentHTML('beforeend', chatMessageHTML({role:'assistant', text:res.text}));
    box.scrollTop = box.scrollHeight;
    if(res.source==='local') toast('本次回答由本地降级生成','gold');
  }catch(err){
    pending.remove();
    console.error('[growth] 复盘对话异常：', err);
    toast('复盘对话异常：'+(err&&err.message||'未知错误'),'red');
  }finally{
    setChatSending(false);
  }
}

function clearReviewChatUI(){
  clearReviewChat();
  reviewChat=[];
  reviewOffline=false;
  applyChatOffline();
  renderReviewChat();
  toast('对话已清空','gold');
}

/* ── 数据页 ── */
function renderData(){
  const today=ds(new Date());
  const streak=computeStreak(S.days, today);
  let d7=0, t7=0;
  for(let i=0;i<7;i++){ const d=new Date(); d.setDate(d.getDate()-i); const s=dayStats(S.days, ds(d)); d7+=s.done; t7+=s.total; }
  const rate= t7? Math.round(d7/t7*100):0;
  $('dataTiles').innerHTML=`
    <div class="stat-tile"><div class="num">${streak}<small> 天</small></div><div class="lbl">连续打卡</div></div>
    <div class="stat-tile"><div class="num">${rate}<small>%</small></div><div class="lbl">近 7 日完成率</div></div>
    <div class="stat-tile"><div class="num">${S.stats.done}</div><div class="lbl">累计完成</div></div>
    <div class="stat-tile"><div class="num">${S.stats.expired}</div><div class="lbl">累计失效</div></div>`;

  // 四维均衡度：偏科会让 AI 持续堆同一维，且事后不可逆，所以在数据页显式暴露
  const vals=CATS.map(c=>S.player.attrs[c]||0);
  const gap=Math.max(...vals)-Math.min(...vals);
  const lag=CATS[vals.indexOf(Math.min(...vals))];
  if(gap>=60){
    $('balanceHint').innerHTML=`⚠ 四维偏科：最高与最低相差 <b>${gap}</b> 点，最弱的是「${lag}」。建议在任务池里补几条${lag}类任务（AI 出题会优先采用）。`;
    $('balanceHint').hidden=false;
  }else{
    $('balanceHint').hidden=true;
  }

  // 近 7 日柱状图
  const bars=[];
  for(let i=6;i>=0;i--){
    const d=new Date(); d.setDate(d.getDate()-i);
    const k=ds(d), s=dayStats(S.days,k);
    const hPct= s.total? Math.round(s.done/s.total*100):0;
    bars.push(`<div class="wb ${i===0?'today':''}">
      <span class="wb-val">${s.done}/${s.total}</span>
      <div class="wb-bar" style="height:${Math.max(hPct,2)}%"></div>
      <span class="wb-label">周${'日一二三四五六'[d.getDay()]}</span></div>`);
  }
  $('weekBars').innerHTML=bars.join('');

  // 月度热力图：最近 12 周，每格一天，颜色深浅=当日完成率
  const end=new Date(); end.setHours(0,0,0,0);
  const start=new Date(end); start.setDate(start.getDate()-(12*7-1));
  start.setDate(start.getDate()-((start.getDay()+6)%7)); // 对齐到周一
  const svgCells=[];
  let dayIdx=0;
  for(const d=new Date(start); d<=end; d.setDate(d.getDate()+1), dayIdx++){
    const k=ds(d), s=dayStats(S.days,k);
    const lv = !s.total ? 0 : s.done===0 ? 1 : Math.min(4, Math.ceil(s.done/s.total*4));
    const col=Math.floor(dayIdx/7), row=dayIdx%7;
    svgCells.push(`<rect class="hm l${lv}" x="${col*13}" y="${row*13}" width="11" height="11" rx="2"><title>${k}：完成 ${s.done}/${s.total}</title></rect>`);
  }
  const W=Math.ceil(dayIdx/7)*13;
  $('heatBox').innerHTML=`<svg class="heatmap" viewBox="0 0 ${W} ${7*13-2}" preserveAspectRatio="xMinYMin meet">${svgCells.join('')}</svg>
    <div class="heat-legend"><span>少</span><i class="hm l0"></i><i class="hm l1"></i><i class="hm l2"></i><i class="hm l3"></i><i class="hm l4"></i><span>多</span></div>`;

  // 四维成长曲线（每日快照，最近 14 天）
  const keys=Object.keys(S.days).filter(k=>S.days[k].snap).sort().slice(-14);
  if(keys.length<2){
    $('curveBox').innerHTML='<div class="curve-hint">数据积累中 —— 系统每天记录一次属性快照，明后天即可看到成长趋势。</div>';
  }else{
    const W=560,H=200,P=10;
    const maxV=Math.max(...keys.flatMap(k=>CATS.map(c=>S.days[k].snap.attrs[c]||0)), NORMAL_ATTR+40);
    const pt=(i,v)=>`${(P+i*(W-2*P)/(keys.length-1)).toFixed(1)},${(H-P-(v/maxV)*(H-2*P)).toFixed(1)}`;
    const lines=CATS.map(c=>`<polyline fill="none" stroke="var(--c-${c})" stroke-width="2.5"
      stroke-linecap="round" stroke-linejoin="round" points="${keys.map((k,i)=>pt(i,S.days[k].snap.attrs[c]||0)).join(' ')}"/>`).join('');
    $('curveBox').innerHTML=`<svg class="curve-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${lines}</svg>
      <div class="curve-legend">${CATS.map(c=>`<span><i style="border-color:var(--c-${c})"></i>${c}</span>`).join('')}</div>
      <div class="hint">${keys[0].slice(5)} → ${keys[keys.length-1].slice(5)} · 每日快照</div>`;
  }

  // 系统周报（超过 7 天视为过期，不能再当"本周评估"看）
  // 生成时把结构化指标一起存下来：数字由本地算好，AI 只解读，
  // 这样即便之后 AI 措辞跑偏，指标卡显示的仍是可信数字。
  if(S.lastReport){
    const age=S.lastReport.t ? Math.floor((Date.now()-S.lastReport.t)/86400000) : 0;
    const stale=age>=7;
    const srcTag = S.lastReport.source==='local'
      ? '<span class="stale-chip">离线生成 · 仅基于本地统计</span>' : '';
    $('reportBox').innerHTML=`
      ${stale?`<div class="stale-chip">已过期 · ${age} 天前生成，建议重新生成</div>`:''}
      ${srcTag}
      ${reportMetricsHTML(S.lastReport.metrics)}
      <div class="report"><span class="card-no">生成于 ${new Date(S.lastReport.t).toLocaleString('zh-CN',{hour12:false})}${stale?'':' · 有效期内'}</span>
       <p>${esc(S.lastReport.text).replace(/\n/g,'<br>')}</p></div>`;
  }else{
    $('reportBox').innerHTML='<div class="curve-hint">还没有周报。点击下方按钮，让系统基于近 7 天数据做一次评估。</div>';
  }

  renderAchievements();
  renderRankTimeline();
  renderPoolStats();
  renderReviewChat();
}

/* ── 任务池采用率：池子不该是个黑洞 ── */
function renderPoolStats(){
  const box = $('poolStats');
  if(!box) return;
  const st = poolStats(S);
  if(!st.poolSize){
    box.innerHTML = '<div class="curve-hint">任务池是空的。加几条常做的任务，AI 出题会优先采用（设置页）。</div>';
    return;
  }
  if(st.issued === 0){
    box.innerHTML = '<div class="curve-hint">任务池有 ' + st.poolSize + ' 条任务，但还没有已发布的任务可统计。等系统发几个任务后再来看。</div>';
    return;
  }
  const rows = st.perTask.slice(0, 8).map(t=>{
    const tag = t.issued === 0 ? '<span class="mv flat">未采用</span>'
      : `<span class="mv ${t.done>0?'up':'flat'}">完成 ${t.done}/${t.issued}</span>`;
    return `<div class="rank-row"><span class="ps-title">${esc(t.title)}</span>
      <span class="muted">发布 ${t.issued} 次</span>${tag}</div>`;
  }).join('');
  const blind = st.neverUsed.length
    ? `<div class="rep-row muted" style="margin-top:10px">从未被采用：${st.neverUsed.slice(0,6).map(esc).join('、')}${st.neverUsed.length>6?` 等 ${st.neverUsed.length} 条`:''}</div>`
    : '';
  box.innerHTML = `<div class="rep-metrics" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      <div class="rm-cell"><div class="rm-v">${st.adoptionRate}<small>%</small></div><div class="rm-l">池内任务采用率</div></div>
      <div class="rm-cell"><div class="rm-v">${st.fromPoolDone}<small>/${st.fromPoolIssued}</small></div><div class="rm-l">池内任务完成</div></div>
      <div class="rm-cell"><div class="rm-v">${st.poolSize}<small>条</small></div><div class="rm-l">任务池规模</div></div>
    </div>
    ${rows}${blind}`;
}

/* 周报指标卡：把"这周怎么样"变成一眼能比的数字 */
function reportMetricsHTML(m){
  if(!m || !m.cur) return '';
  const r=m.cur, pv=m.prev;
  const dRate = pv.total ? m.rateDelta : null;
  const arrow = dRate===null ? '<span class="mv flat">暂无基线</span>'
    : dRate>0 ? `<span class="mv up">▲ ${dRate}</span>`
    : dRate<0 ? `<span class="mv down">▼ ${Math.abs(dRate)}</span>`
    : '<span class="mv flat">持平</span>';
  const attr = m.attrDelta
    ? CATS.map(c=>{
        const v=m.attrDelta[c]||0;
        return `<span class="ad ${v>0?'up':v<0?'down':'flat'}">${c} ${v>0?'+':''}${v}</span>`;
      }).join('')
    : '<span class="ad flat">快照不足</span>';
  return `<div class="rep-metrics">
    <div class="rm-cell"><div class="rm-v">${r.done}<small>/${r.total}</small></div><div class="rm-l">完成任务</div></div>
    <div class="rm-cell"><div class="rm-v">${r.rate}<small>%</small> ${arrow}</div><div class="rm-l">完成率（对比上周）</div></div>
    <div class="rm-cell"><div class="rm-v">${r.activeDays}<small>/7</small></div><div class="rm-l">有效行动天数</div></div>
    <div class="rm-cell"><div class="rm-v">${m.streak}<small>天</small></div><div class="rm-l">连续打卡</div></div>
  </div>
  <div class="rep-row"><b>属性增量</b>${attr}</div>
  <div class="rep-row"><b>投入最多</b><span class="ad up">${esc(m.strongest||'无')}</span>
    <b style="margin-left:16px">最需补强</b><span class="ad down">${esc(m.weakest||'无')}（${m.weakestValue||0} · ${attrRank(m.weakestValue||0)} 级）</span></div>
  <div class="rep-row muted">统计区间 ${m.range.from} ~ ${m.range.to}${r.expired?` · 失效 ${r.expired}`:''}${r.voided?` · 突发收回 ${r.voided}`:''}${r.partial?` · 半奖未收尾 ${r.partial}`:''}</div>
  ${rescueRowHTML(m)}
  ${m.weakest ? `<div class="rep-action">
    <button class="btn btn-sm btn-primary" data-act="reportToPool">把「${esc(m.weakest)}」补强任务加入任务池</button>
    <span class="hint">按最薄弱维度自动挑选 3 条，加入后 AI 出题会优先采用</span>
  </div>` : ''}`;
}

/* 补救复盘行：回答"我的作息和发布时段是否匹配"，这是补救机制反复在提示的信号 */
function rescueRowHTML(m){
  const rs = m.cur && m.cur.rescue;
  const ins = m.rescueInsight;
  if(!rs || !ins) return '';
  const d = m.rescueDelta;
  const cmp = (m.prev && m.prev.rescue && (m.prev.rescue.events || d))
    ? (d>0 ? `<span class="mv down">▲ 比上周多 ${d} 次</span>`
      : d<0 ? `<span class="mv up">▼ 比上周少 ${Math.abs(d)} 次</span>`
      : '<span class="mv flat">与上周持平</span>')
    : '';
  const detail = rs.events
    ? `<span class="ad flat">支线重计时 ${rs.side}</span>
       <span class="ad flat">突发救回 ${rs.burst}</span>
       <span class="ad flat">补交窗口 ${rs.grace}</span>
       ${rs.quotaDays ? `<span class="ad down">额度用光 ${rs.quotaDays} 天</span>` : ''}
       ${rs.maxGap ? `<span class="ad flat">最长离开 ${Math.round(rs.maxGap/60*10)/10} 小时</span>` : ''}`
    : '<span class="ad up">0 次</span>';
  return `<div class="rep-row"><b>补救复盘</b>${detail}${cmp}</div>
    <div class="rescue-insight ${ins.level}">${esc(ins.text)}${windowFixHTML(m, ins)}</div>`;
}

/* 诊断 → 修复：warn 时给出「一键把活跃窗口调到你实际的时段」。
   没有建议（样本不足）就不显示按钮，避免拿一两次数据乱改设置。 */
function windowFixHTML(m, ins){
  const w = m.windowSuggestion;
  if(ins.level!=='warn' || !w || !w.changed) return '';
  return `<div class="win-fix">
    <button class="btn btn-sm" data-act="applyWindow">把活跃窗口调到我实际的时段（${w.start}–${w.end}）</button>
    <span class="hint">依据近 7 天 ${w.samples} 次完成时刻推算 · 今日已发布的任务不受影响，明天起生效</span>
  </div>`;
}

/* ── 属性突破记录（数据页）：跨级是稀有事件，值得单独留痕 ── */
function renderRankTimeline(){
  const ups = S.rankUps || [];
  const box = $('rankList');
  if(!box) return;
  if(!ups.length){
    box.innerHTML = '<div class="curve-hint">还没有属性突破。任一维度达到 40（E）、90（D）、160（C）… 会在这里留痕。</div>';
    return;
  }
  box.innerHTML = ups.map(u=>{
    const d = new Date(u.t);
    return `<div class="rank-row"><span class="chip cat-${u.cat}">${u.cat}</span>
      <b class="rk">${u.rank} 级</b>
      <span class="muted">${rankInfo(u.value).name} · ${u.value}</span>
      <time>${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}</time></div>`;
  }).join('');
}

/* ── 成就（数据页）── */
function renderAchievements(){
  const got=new Set(S.achievements||[]);
  const n=ACHIEVEMENTS.filter(a=>got.has(a.id)).length;
  $('achHead').textContent=`${n}/${ACHIEVEMENTS.length}`;
  $('achList').innerHTML=ACHIEVEMENTS.map(a=>{
    const done=got.has(a.id);
    return `<div class="ach ${done?'got':''}"><span class="ach-ico">${done?'🏆':'○'}</span>
      <div><div class="ach-name">${esc(a.name)}</div><div class="ach-desc">${esc(a.desc)}</div></div></div>`;
  }).join('');
}

function fmtRemain(dl){  const s=Math.floor((dl-Date.now())/1000);
  if(s<=0) return '已超时';
  const h=Math.floor(s/3600), m=Math.floor(s%3600/60), sec=s%60;
  return `剩 ${h?h+':':''}${pad(m)}:${pad(sec)}`;
}
/* 离开了多久：分钟级太啰嗦，超过 1 小时按小时说 */
function fmtGap(min){
  const m=Math.round(min||0);
  return m>=60 ? `${(m/60).toFixed(1)} 小时` : `${Math.max(1,m)} 分钟`;
}
function renderAll(){ renderHero(); renderTasks(); renderShop(); renderLog(); renderPool(); renderData(); }

/* ── 任务池（设置页）── */
function renderPool(){
  $('poolList').innerHTML = S.taskPool.length ? S.taskPool.map((t,i)=>
    `<div class="shop-item"><span class="n">${esc(t.title)}</span>
      <span class="chip cat-${t.category}">${t.category}</span>
      <span class="cost">${'★'.repeat(t.difficulty)} · ${t.minutes}分钟</span>
      <button class="btn btn-sm btn-quiet" data-act="poolDel" data-i="${i}">✕</button></div>`).join('')
    : '<div class="empty">任务池为空。加入你想反复做的任务，AI 出题会优先采用。</div>';
}

/* ── 页面切换 ── */
function showPage(p){
  if(!['today','shop','log','data','settings'].includes(p)) p='today';
  for(const sec of document.querySelectorAll('.page')) sec.hidden = sec.id!=='page-'+p;
  document.querySelectorAll('.nav-btn').forEach(b=>b.setAttribute('aria-selected', String(b.dataset.page===p)));
  S.settings.page=p; save();
}

/* ── 主题：light / dark / auto（auto 跟随系统）── */
const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function applyTheme(){
  const t = S.settings.theme;
  const resolved = t==='auto' ? (darkQuery && darkQuery.matches ? 'dark':'light') : (t==='dark'?'dark':'light');
  document.body.dataset.theme = resolved;
  return resolved;
}

/* ── 设置绑定 ── */
function bindSettings(){
  applyTheme();
  // 称号下拉：只列已解锁的
  const sel=$('sTitle');
  const owned=availableTitles(S);
  sel.innerHTML='<option value="">（不佩戴）</option>' +
    owned.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('');
  sel.value = (S.player.title && owned.some(t=>t.id===S.player.title)) ? S.player.title : '';
  // 主线编辑框回填当前值
  const mq=ensureMainQuest(S);
  $('mqEditTitle').value = mq.title;
  $('mqEditTarget').value = mq.target;

  const map=[['sName',()=>S.player.name,v=>S.player.name=v||'宿主'],
    ['sTheme',()=>S.settings.theme,v=>{S.settings.theme=v;applyTheme();}],
    ['sGoal',()=>S.settings.goal,v=>S.settings.goal=v],
    ['sTone',()=>S.settings.tone,v=>{S.settings.tone=TONES[v]?v:DEFAULT_TONE;}],
    ['sTitle',()=>S.player.title,v=>{S.player.title=v;renderHero();}],
    ['sDayStart',()=>S.settings.dayStart,v=>S.settings.dayStart=v],
    ['sDayEnd',()=>S.settings.dayEnd,v=>S.settings.dayEnd=v],
    ['sApi',()=>S.settings.api,v=>S.settings.api=v.trim()||'/api/v1'],
    ['sKey',()=>S.settings.key,v=>S.settings.key=v.trim()],
    ['sModel',()=>S.settings.model,v=>S.settings.model=v.trim()],
    ['sSound',()=>S.settings.sound?'checked':'',v=>S.settings.sound=!!v]];
  for(const [id,get,set] of map){
    const el=$(id); el[el.type==='checkbox'?'checked':'value']=get();
    el.addEventListener('change',()=>{
      set(el[el.type==='checkbox'?'checked':'value']); save();
      if(id==='sDayStart'||id==='sDayEnd'){ // 窗口变更且今日尚无已发布任务 → 重排今日
        const today=ds(new Date()), day=S.days[today];
        if(day && day.slots.every(s=>s.status==='waiting')) delete S.days[today];
        settle().catch(e=>console.error('[growth] 重排失败：',e)).then(UI.renderAll);
      }
      renderHero();
    });
  }
  // 系统主题变化时，auto 模式要跟着变
  if(darkQuery && darkQuery.addEventListener){
    darkQuery.addEventListener('change', ()=>{ if(S.settings.theme==='auto') applyTheme(); });
  }
}

/* ── 事件委托 ── */
/* 点击分发：抽成具名函数，便于无头测试直接调用（内联监听器无法在沙箱里触发）。
   e 只在 'done' 分支用于读输入框，因此允许传 null。 */
async function runAction(act, b, e){
  if(act==='done'){
    const note=b.parentElement?.querySelector('[data-note]')?.value.trim()||'';
    completeTask(b.dataset.day, +b.dataset.i, note);
  }
  else if(act==='abandon') abandonTask(b.dataset.day, +b.dataset.i);
  else if(act==='undo'){ undoComplete(); if(undoBar){ undoBar.remove(); undoBar=null; } }
  else if(act==='toggleDone'){ showDone=!showDone; renderTasks(); }
  else if(act==='partial') startPartial(b.dataset.day, +b.dataset.i);
  else if(act==='buy') buyItem(+b.dataset.i);
  else if(act==='shopDel'){ S.shop.splice(+b.dataset.i,1); save(); renderShop(); }
  else if(act==='poolDel'){ S.taskPool.splice(+b.dataset.i,1); save(); renderPool(); }
  else if(act==='poolAdd'){
    const title=$('poolTitle').value.trim(), minutes=Math.min(120,Math.max(5,+$('poolMin').value||30));
    if(!title) return toast('填写任务标题','red');
    S.taskPool.push({ title:title.slice(0,40), desc:'', category:$('poolCat').value,
      difficulty:+$('poolDiff').value||2, minutes });
    $('poolTitle').value=''; $('poolMin').value='';
    log(`任务池新增：「${title}」`); save(); renderPool();
  }
  else if(act==='mqSave'){
    const title=$('mqEditTitle').value.trim();
    const target=Math.min(999,Math.max(3,+$('mqEditTarget').value||30));
    if(!title) return toast('填写主线名称','red');
    const q=ensureMainQuest(S);
    q.title=title.slice(0,24);
    if(target!==q.target){  // 目标改了，里程碑跟着重算，进度保持在范围内
      q.target=target;
      q.milestones=[Math.round(target*0.33),Math.round(target*0.66),target].filter((v,i,a)=>a.indexOf(v)===i);
      q.doneMilestones=(q.doneMilestones||[]).filter(m=>m<=target);
      q.completed=q.progress>=target;
    }
    log(`主线任务已设定：「${q.title}」，目标 ${q.target} 个任务。`,'up');
    save(); renderMainQuest(); toast('主线已更新','gold');
  }
  else if(act==='applyWindow'){
    // 把「作息错位」的诊断直接落成设置改动，而不是让用户自己去设置页手填。
    // 注意：这里必须用当前状态重新计算，不能读 S.lastReport.metrics —— 那是生成周报时的
    // 历史快照，改完设置后它仍停留在 changed:true，会导致重复调整、重复写公告。
    const w = suggestActiveWindow(S, ds(new Date()), 7);
    if(!w) return toast('数据还不够，再积累几天完成记录','red');
    if(!w.changed) return toast('活跃窗口已经是你的实际时段了','gold');
    const oldStart = S.settings.dayStart, oldEnd = S.settings.dayEnd;
    S.settings.dayStart = w.start;
    S.settings.dayEnd = w.end;
    log(`根据近 7 天 ${w.samples} 次完成时刻，系统把活跃窗口从 ${oldStart}–${oldEnd} 调整为 ${w.start}–${w.end}。今日已发布的任务不受影响，明天起按新时段发布。`,'up');
    save(); renderData();
    // 设置页的输入框要跟着更新，否则用户切过去看到的是旧值
    if($('sDayStart')) $('sDayStart').value = w.start;
    if($('sDayEnd')) $('sDayEnd').value = w.end;
    toast(`活跃窗口已改为 ${w.start}–${w.end}`,'gold');
  }
  else if(act==='reportToPool'){
    // 周报的"最需补强"直接变成任务池里的具体条目，让建议可执行
    const m = S.lastReport && S.lastReport.metrics;
    if(!m || !m.weakest) return toast('先重新生成一次周报','red');
    const picked = suggestTasksFor(m, FALLBACK_POOL, S.taskPool, 3);
    if(!picked.length) return toast(`任务池里已经有「${m.weakest}」的候选任务了`,'gold');
    const have = new Set(S.taskPool.map(t=>t.title));
    let added = 0;
    for(const t of picked){
      if(have.has(t.title)) continue;
      S.taskPool.push(t); have.add(t.title); added++;
    }
    if(!added) return toast('没有可新增的任务','red');
    log(`根据周报建议，系统向任务池补充了 ${added} 条「${m.weakest}」任务。`,'up');
    save(); renderData(); renderPool();
    toast(`已加入 ${added} 条「${m.weakest}」任务`,'gold');
  }
  else if(act==='poolBulkImport'){
    const raw=$('poolBulk').value.trim();
    if(!raw) return toast('先粘贴几行任务','red');
    let added=0, skipped=0;
    const have=new Set(S.taskPool.map(t=>t.title));
    for(const line of raw.split(/\r?\n/)){
      const s=line.trim(); if(!s) continue;
      // 格式：标题 | 分类 | 难度 | 分钟（后三项可省略）
      const [title,cat,diff,min] = s.split(/[|｜]/).map(x=>x.trim());
      if(!title) continue;
      if(have.has(title.slice(0,40))){ skipped++; continue; }
      have.add(title.slice(0,40));
      S.taskPool.push({ title:title.slice(0,40), desc:'',
        category: CATS.includes(cat)?cat:mapCategory(cat||''),
        difficulty: Math.min(3,Math.max(1,+diff||2)),
        minutes: Math.min(120,Math.max(5,+min||30)) });
      added++;
    }
    $('poolBulk').value='';
    log(`任务池批量导入：新增 ${added} 条${skipped?`，跳过重复 ${skipped} 条`:''}。`);
    save(); renderPool();
    toast(added?`已加入 ${added} 条任务`:'没有新增（可能全部重复）', added?'gold':'red');
  }
  else if(act==='poolFromDone'){
    // 把近 7 天完成过的任务加进任务池（常做的事就该沉淀下来）
    const have=new Set(S.taskPool.map(t=>t.title));
    let added=0;
    for(let i=0;i<7;i++){
      const d=new Date(); d.setDate(d.getDate()-i);
      const rec=S.days[ds(d)]; if(!rec) continue;
      for(const sl of rec.slots){
        if(sl.status!=='done'||!sl.task||have.has(sl.task.title)) continue;
        have.add(sl.task.title);
        S.taskPool.push({ title:sl.task.title.slice(0,40), desc:(sl.task.desc||'').slice(0,200),
          category:sl.task.category, difficulty:sl.task.difficulty||2, minutes:sl.task.minutes||30 });
        added++;
      }
    }
    if(added){ log(`从近 7 天完成记录中沉淀 ${added} 条任务到任务池。`); save(); renderPool(); toast(`已沉淀 ${added} 条常规任务`,'gold'); }
    else toast('近 7 天没有可沉淀的新任务','red');
  }
  else if(act==='shopAdd'){
    const name=$('shopName').value.trim(), cost=+$('shopCost').value;
    if(!name||!cost||cost<1) return toast('填写奖励名称和价格','red');
    S.shop.push({name,cost:Math.round(cost)}); $('shopName').value=''; $('shopCost').value='';
    log(`商城上架：「${name}」（${Math.round(cost)} 金币）`); save(); renderShop();
  }
  else if(act==='chatSend'){ await sendReviewChat(); }
  else if(act==='chatClear'){ clearReviewChatUI(); }
  else if(act==='testApi'){
    b.textContent='连接中…'; b.disabled=true;
    try{
      const res=await fetch(S.settings.api.replace(/\/$/,'')+'/models',{headers:{Authorization:'Bearer '+S.settings.key}});
      const j=await res.json();
      toast(res.ok?`连接成功，${(j.data||[]).length} 个模型可用`:'网关响应异常 HTTP '+res.status, res.ok?'':'red');
      log(res.ok?`网关连接测试成功（${(j.data||[]).length} 个模型）。`:'网关连接测试失败：HTTP '+res.status, res.ok?'sys':'bad');
    }catch(err){ toast('连接失败：'+err.message,'red'); }
    b.textContent='测试连接'; b.disabled=false;
  }
  else if(act==='export'){
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([JSON.stringify(S,null,2)],{type:'application/json'}));
    a.download=`成长系统存档-${ds(new Date())}.json`; a.click(); URL.revokeObjectURL(a.href);
  }
  else if(act==='import'){ $('importFile').click(); }
  else if(act==='selftest'){ const ok=selftest(); toast(ok?'自检通过 ✓':'自检失败，看控制台详情', ok?'':'red'); }
  else if(act==='report'){
    if(reportBusy) return;
    reportBusy=true; b.disabled=true; b.textContent='系统评估中…';
    $('reportBox').innerHTML='<div class="curve-hint">⬡ 系统推演中，正在基于近 7 天数据生成评估…</div>';
    try{
      const res=await callReport();
      S.lastReport={t:Date.now(), text:res.text, metrics:res.metrics, source:res.source};
      log(res.source==='local'
        ? '网关不可用，系统已用本地统计生成周报。'
        : '系统周报已生成，宿主可阅。','up');
      save(); renderData();
      toast(res.source==='local' ? '周报已生成（离线模式）' : '周报已生成','gold');
    }catch(err){ toast('周报生成失败：'+err.message,'red'); renderData(); }
    b.disabled=false; b.textContent='生成系统周报'; reportBusy=false;
  }
}

document.addEventListener('click', async e=>{
  const nav=e.target.closest('.nav-btn[data-page]');
  if(nav) return showPage(nav.dataset.page);
  // 用 [data-act] 而不是 button[data-act]：折叠开关是 div，其他可点元素也都能接进来
  const b=e.target.closest('[data-act]'); if(!b) return;
  await runAction(b.dataset.act, b, e);
});
$('importFile').addEventListener('change', e=>{
  const f=e.target.files[0]; if(!f) return;
  const rd=new FileReader();
  rd.onload=()=>{ try{
    const s=JSON.parse(rd.result);
    if(!s.player||!s.settings) throw new Error('存档结构不对');
    // 原地合并：S 是顶层 let，但 ui.js 里多处直接闭包引用 S，重新赋值不如就地覆盖稳妥
    for(const k of Object.keys(S)) delete S[k];
    Object.assign(S, migrate(s));
    save(); log('存档导入成功。','up'); renderAll(); bindSettings(); toast('存档已导入','gold');
  }catch(err){ toast('导入失败：'+err.message,'red'); } };
  rd.readAsText(f); e.target.value='';
});

/* 引擎回调钩子 */
window.UI={ toast, ding, renderAll, renderTasks, undo };

/* ── 复盘对话：Enter 发送 + 网关离线时的本地降级回复 ──
   每轮请求的数字上下文每轮重算（见 ai.js 的 reviewContext），对话历史的职责
   只是保持连贯。网关不可用时不只弹 toast，还用本地统计拼一条明确的降级回复，
   界面永远不落在「空白报错」上。 */
document.addEventListener('keydown', e=>{
  if(e.key!=='Enter' || e.target!==$('chatInput')) return;
  e.preventDefault();
  sendReviewChat();
});

/* 本地降级回复：离线时用真实数字回答最常见的问题，而不是只说「连不上」。
   复用 weekMetrics，一句话不编。 */
function reviewLocalReply(){
  const m = weekMetrics(S, ds(new Date()), 7);
  const r = m.cur;
  const tone = TONES[S.settings.tone] || TONES[DEFAULT_TONE];
  const L=[];
  L.push(`${tone.open} 神经链路离线，先基于本地统计作答：`);
  if(r.total===0){
    L.push(`近 7 天没有已发布的任务记录，档案还在积累。确认活跃窗口（${S.settings.dayStart}–${S.settings.dayEnd}）符合作息后，系统会开始发布任务。`);
  }else{
    L.push(`近 7 天完成 ${r.done}/${r.total}（${r.rate}%），有效行动 ${r.activeDays} 天，连续打卡 ${m.streak} 天，失效 ${r.expired} 个、突发收回 ${r.voided} 个。`);
    if(m.weakest) L.push(`最薄弱的维度是「${m.weakest}」（当前 ${m.weakestValue}，${attrRank(m.weakestValue)} 级）。`);
    if(r.expired>0 || r.voided>0) L.push(`失效与收回集中在这些天——对照上方逐日数据看，崩的时间点通常不是意志力问题，而是时段错位。`);
    L.push(`链路恢复后再问「为什么我周末总崩」这类问题，系统才能结合周报细说。`);
  }
  return L.join('\n');
}
