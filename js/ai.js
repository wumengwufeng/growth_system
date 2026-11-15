'use strict';
/* ai.js — 任务生成：Magpie 网关调用，失败降级本地任务池。
   依赖：core.js（ds/rngFor/CATS）、state.js（S）。 */

/* 内置任务池：起步任务与连锁任务不走 AI，只从这里挑，所以每个维度/难度都要有足够多条，
   否则（早期自律★1 只有两条）同一批标题会天天循环出现。新增条目的口径与原来一致：
   20~60 分钟内可独自完成、不需要他人配合、基本不花钱。 */
const FALLBACK_POOL = [
  // 体质
  {title:'俯卧撑 3 组', desc:'每组力竭，组间休息 60 秒。', category:'体质', difficulty:1, minutes:15},
  {title:'肩颈拉伸 10 分钟', desc:'久坐者的赎罪。跟着任意拉伸视频做。', category:'体质', difficulty:1, minutes:10},
  {title:'深蹲 30 个 × 3 组', desc:'动作慢一点，膝盖别内扣。', category:'体质', difficulty:1, minutes:10},
  {title:'平板支撑 3 次', desc:'每次撑到发抖为止，组间休息 45 秒。', category:'体质', difficulty:1, minutes:10},
  {title:'快走或慢跑 20 分钟', desc:'出门，抬头，看路。', category:'体质', difficulty:2, minutes:20},
  {title:'爬楼 10 层', desc:'走楼梯不坐电梯，上去再下来。', category:'体质', difficulty:2, minutes:15},
  {title:'全身拉伸 20 分钟', desc:'从颈到脚踝，每个部位停留 30 秒。', category:'体质', difficulty:2, minutes:20},
  {title:'跑满 5 公里', desc:'不看配速，跑完就行。', category:'体质', difficulty:3, minutes:45},
  {title:'徒手 HIIT 30 分钟', desc:'跟着任意高强度间歇视频做，做完应该是湿的。', category:'体质', difficulty:3, minutes:30},
  // 智力
  {title:'快捷键练习 15 分钟', desc:'挑一个常用软件，练熟 3 个新快捷键。', category:'智力', difficulty:1, minutes:15},
  {title:'背 10 个单词', desc:'当天晚上再默写一遍。', category:'智力', difficulty:1, minutes:10},
  {title:'读 5 页书', desc:'纸质或电子都行，读完划一句。', category:'智力', difficulty:1, minutes:10},
  {title:'读书 20 页', desc:'任意书。读完写一句感想，写在哪都行。', category:'智力', difficulty:2, minutes:30},
  {title:'学一个概念并复述', desc:'挑一个技术/领域概念，用自己的话写 3 行总结。', category:'智力', difficulty:2, minutes:25},
  {title:'写 300 字技术笔记', desc:'把今天学到的一个点讲清楚，能给别人看。', category:'智力', difficulty:2, minutes:25},
  {title:'读完一篇论文并总结', desc:'摘要、结论、方法，各写一句。', category:'智力', difficulty:3, minutes:45},
  {title:'手写一个最小可运行脚本', desc:'不超过 50 行，能跑起来就算成功。', category:'智力', difficulty:3, minutes:40},
  // 精神
  {title:'冥想或深呼吸 10 分钟', desc:'闭眼，专注呼吸，走神了就拉回来。', category:'精神', difficulty:1, minutes:10},
  {title:'写 3 件值得谢的事', desc:'具体到人和事，不写"感谢生活"这种。', category:'精神', difficulty:1, minutes:10},
  {title:'出门晒 10 分钟太阳', desc:'不带手机，或者带但不看。', category:'精神', difficulty:1, minutes:10},
  {title:'主动联系一个人', desc:'给很久没聊的朋友或家人发条消息。', category:'精神', difficulty:2, minutes:10},
  {title:'23:30 前上床', desc:'今晚把手机放到够不着的地方。', category:'精神', difficulty:2, minutes:20},
  {title:'连续 30 分钟不碰手机', desc:'放到另一个房间，计时开始。', category:'精神', difficulty:2, minutes:30},
  {title:'写一封没打算寄出的信', desc:'写给谁都可以，写完可以撕掉。', category:'精神', difficulty:3, minutes:30},
  {title:'独处散步 40 分钟', desc:'不带耳机，让脑子自己跑。', category:'精神', difficulty:3, minutes:40},
  // 自律
  {title:'快速整理 15 分钟', desc:'桌面或房间，计时开始。', category:'自律', difficulty:1, minutes:15},
  {title:'清空一个收藏夹', desc:'把收藏了很久没看的内容清掉或看完。', category:'自律', difficulty:1, minutes:15},
  {title:'扔掉 5 样没用的东西', desc:'过期的、坏了的、一年没碰过的。', category:'自律', difficulty:1, minutes:15},
  {title:'把散落的文件归到一个文件夹', desc:'桌面先清空再说。', category:'自律', difficulty:1, minutes:15},
  {title:'200 字今日复盘', desc:'今天做得最好的一件事、最糟的一件事。', category:'自律', difficulty:2, minutes:15},
  {title:'列出明日必做的 3 件事', desc:'只写 3 件，写多了等于没写。', category:'自律', difficulty:2, minutes:15},
  {title:'处理掉一件拖了三天的事', desc:'挑最不想碰的那件，先做 10 分钟。', category:'自律', difficulty:2, minutes:30},
  {title:'清理一个数字空间 40 分钟', desc:'相册、下载目录、邮箱，任选一个。', category:'自律', difficulty:3, minutes:40},
  {title:'复盘本周并写下一条要改的习惯', desc:'具体到"什么时候、什么场景、改成什么"。', category:'自律', difficulty:3, minutes:40},
];

function mapCategory(c){
  c = String(c||'');
  if(CATS.includes(c)) return c;
  if(/体|运|健身|跑|力/.test(c)) return '体质';
  if(/智|学|知|读|思|数|技/.test(c)) return '智力';
  if(/精|心|情|眠|冥|静/.test(c)) return '精神';
  return '自律';
}

function sanitize(arr, n, kinds){
  const out=[];
  for(const raw of arr){
    if(!raw || typeof raw.title!=='string' || !raw.title.trim()) continue;
    out.push({
      title: raw.title.trim().slice(0,40),
      desc: String(raw.desc||'').trim().slice(0,500),
      category: mapCategory(raw.category),
      difficulty: Math.min(3,Math.max(1,raw.difficulty|0||1)),
      minutes: Math.min(120,Math.max(5,raw.minutes|0||30)),
      kind: kinds[out.length]||'side',
    });
    if(out.length>=n) break;
  }
  return out;
}

/* 网关不可用时不该让界面永远停在「推演中」：给每次调用加硬超时。
   网关离线/挂起时，宁可快速降级到内置任务池，也不要卡住整轮结算。 */
const AI_TIMEOUT_MS = 20000;

async function fetchWithTimeout(url, opts, ms){
  const ctrl = typeof AbortController!=='undefined' ? new AbortController() : null;
  let timer = null;
  const timeout = new Promise((_, rej)=>{
    timer = setTimeout(()=>{
      if(ctrl) try{ ctrl.abort(); }catch(e){}
      rej(new Error('网关超时'));
    }, ms);
  });
  try{
    return await Promise.race([ fetch(url, ctrl ? {...opts, signal:ctrl.signal} : opts), timeout ]);
  }finally{ clearTimeout(timer); }
}

/* 通用对话调用：2 次重试，返回纯文本（周报与任务生成共用） */
async function chat(messages, temperature=0.7){
  const st=S.settings;
  let lastErr=null;
  for(let i=0;i<2;i++){
    try{
      const res = await fetchWithTimeout(st.api.replace(/\/$/,'')+'/chat/completions', {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+st.key},
        body: JSON.stringify({model:st.model, temperature, max_tokens:2000, messages})
      }, AI_TIMEOUT_MS);
      if(!res.ok) throw new Error('HTTP '+res.status);
      const j = await res.json();
      const txt = (j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content)||'';
      if(!txt.trim()) throw new Error('响应为空');
      return txt.trim();
    }catch(e){ lastErr=e; }
  }
  throw lastErr||new Error('网关不可用');
}

/* 周报：本地先算出结构化指标（数字不交给 AI 编），AI 只负责解读与建议。
   网关不可用时自动降级为 localReport()，保证这个功能永远有输出。 */
async function callReport(){
  const today=ds(new Date());
  const m = weekMetrics(S, today, 7);
  const r = m.cur, pr = m.prev;

  const rows=[];
  for(let i=6;i>=0;i--){
    const d=new Date(); d.setDate(d.getDate()-i); const k=ds(d);
    const s=dayStats(S.days,k);
    rows.push(`${k}（周${'日一二三四五六'[d.getDay()]}）：完成 ${s.done}/${s.total}${s.expired?`，失效 ${s.expired}`:''}${s.void?`，突发收回 ${s.void}`:''}`);
  }
  const notes=[];
  for(const d of Object.keys(S.days).sort().reverse()){
    for(const sl of S.days[d].slots) if(sl.status==='done' && sl.note) notes.push(`${d}「${sl.task.title}」：${sl.note}`);
    if(notes.length>=10) break;
  }

  const attrTxt = m.attrDelta
    ? Object.entries(m.attrDelta).map(([k,v])=>`${k}${v>=0?'+':''}${v}`).join('  ')
    : '（快照不足，暂无增量）';

  const sys=`你是「个人成长系统」的AI，系统流小说风格。基于宿主近 7 天的**已算好**的统计数字写一份系统评估周报。要求：
- 用系统对宿主说话的口吻，务实不吹捧，不要说空话
- **不要编造数字**：所有数量、比例只能用下面给出的；引用时保持原值
- 结构：整体评价（2-3 句，含与上周对比）→ 亮点 → 问题与盲区（针对给出的失效/收回/半奖）→ 下周建议（2-3 条，具体可执行，点名要补的维度）
- **补救复盘要单独说**：若「离开期间错过提醒」不为 0，指出这不是执行问题而是发布时段与作息错位，建议调整活跃窗口；若为 0 则明确肯定时段匹配
- 数据可能只有 1-2 天（新宿主），如实说明数据还在积累，不要虚构趋势
- 只输出周报正文，不要寒暄和标题`;

  const user=`【已核算的统计】
统计区间：${m.range.from} ~ ${m.range.to}
完成任务：${r.done} / ${r.total}（完成率 ${r.rate}%）
有效行动天数：${r.activeDays} / 7
连续打卡：${m.streak} 天
失效任务：${r.expired} 个；突发被收回：${r.voided} 个；停在半奖未收尾：${r.partial} 个
各维度投入次数：${Object.keys(r.byCat).length? Object.entries(r.byCat).map(([k,v])=>`${k} ${v}`).join('、') : '（无）'}
投入最多的维度：${m.strongest||'（无）'}
四维当前值：${JSON.stringify(S.player.attrs)}（Lv.${S.player.level}，EXP ${S.player.exp}/${expToNext(S.player.level)}）
本周属性增量：${attrTxt}
最薄弱的维度：${m.weakest||'（无）'}（当前 ${m.weakestValue}，${attrRank(m.weakestValue)} 级）
【补救复盘】离开期间错过提醒 ${r.rescue.events} 次（涉及 ${r.rescue.awayDays} 天）：支线重计时 ${r.rescue.side} 次、突发救回 ${r.rescue.burst} 次、补交窗口 ${r.rescue.grace} 次；救回额度用光 ${r.rescue.quotaDays} 天；最长一次离开 ${r.rescue.maxGap} 分钟
【上周对比】${pr.total? `完成 ${pr.done}/${pr.total}（${pr.rate}%），完成率${m.rateDelta>0?'上升':m.rateDelta<0?'下降':'持平'} ${Math.abs(m.rateDelta)} 个百分点` : '上周无任务记录，无可比基线'}

【近 7 天逐日】
${rows.join('\n')}
【宿主的完成记录】
${notes.join('\n')||'（无）'}`;

  try{
    const text = await chat([{role:'system',content:sys},{role:'user',content:user}]);
    return { text, metrics:m, source:'ai' };
  }catch(err){
    console.warn('[growth] 周报 AI 失败，降级本地生成：', err && err.message);
    return { text: localReport(m), metrics:m, source:'local' };
  }
}

/* 自定义任务池：有则提示 AI 优先采用 */
function poolNote(){
  if(!S.taskPool || !S.taskPool.length) return '';
  return `\n宿主的自定义任务池（优先从中选择或改编，也可自拟更贴合的）：
${S.taskPool.map(t=>`- ${t.title}（${t.category}，难度${t.difficulty}，约${t.minutes}分钟）`).join('\n')}`;
}

/* 难度自适应：按近 7 日完成率调节出题难度 */
function difficultyHint(){
  let done=0,total=0;
  for(let i=0;i<7;i++){ const d=new Date(); d.setDate(d.getDate()-i); const s=dayStats(S.days,ds(d)); done+=s.done; total+=s.total; }
  if(total<5) return '';
  const rate=done/total;
  if(rate>=0.8) return '\n宿主近期完成率很高（'+Math.round(rate*100)+'%），请以难度 3 的挑战型任务为主。';
  if(rate<0.4) return '\n宿主近期完成率偏低（'+Math.round(rate*100)+'%），请以难度 1 的轻量任务为主，帮助重建节奏。';
  return '';
}

async function callAI(n, kinds){
  const st=S.settings;
  const recent = [];
  for(const d of Object.keys(S.days).sort().reverse()){
    for(const sl of S.days[d].slots) if(sl.status==='done' && sl.task) recent.push(sl.task.title);
    if(recent.length>=8) break;
  }
  // 今天已经发出去的任务（含待办）：AI 此前完全看不到，可能再发一条一模一样的
  const today = ds(new Date());
  const todayTitles = ((S.days[today] && S.days[today].slots) || [])
    .filter(sl=>sl.task).map(sl=>sl.task.title);
  const hist = titleHistory(S.days, today);
  const recentAll = [...hist.recent].filter(t=>!todayTitles.includes(t));
  const sys = `你是「个人成长系统」的任务发布AI，类似系统流小说里的系统。为宿主发布真实、当天可完成的个人成长任务。要求：
- 20~60 分钟内可自主完成，不需要他人配合、不花钱或少花钱
- 具体可操作，拒绝空泛（"读《xx》任意一章并写 3 句笔记" 优于 "多读书"）
- 为四个维度保持平衡：若某一维明显落后，优先补它
- 可少量使用系统流的口吻，但任务本身必须务实
- **绝对不要**与下面列出的「今天已发布」「近 7 天出现过」的任务重名或近似重复，换个切入角度
- category 必须从 [体质,智力,精神,自律] 中选择；difficulty：1=轻量 2=标准 3=挑战；minutes=预计分钟
只输出一个 JSON 数组，禁止输出其他任何文字或代码块标记：
[{"title":"","desc":"","category":"","difficulty":1,"minutes":30}]`;
  const user = `宿主目标：${st.goal}
四维属性：${JSON.stringify(S.player.attrs)}
最近完成的任务：${recent.slice(0,8).join('；')||'（新宿主，尚无记录）'}
今天已发布的任务（不要重复）：${todayTitles.join('；')||'（无）'}
近 7 天出现过的任务（不要重复）：${recentAll.slice(0,20).join('；')||'（无）'}
请发布恰好 ${n} 个任务，贴合目标，避开以上所有重复。
${poolNote()}${difficultyHint()}`;
  let lastErr=null;
  for(let i=0;i<2;i++){
    try{
      const txt = await chat([{role:'system',content:sys},{role:'user',content:user}], 0.9);
      const m = txt.match(/\[[\s\S]*\]/);
      if(!m) throw new Error('响应中无 JSON 数组');
      const arr = sanitize(JSON.parse(m[0]), n, kinds);
      if(!arr.length) throw new Error('JSON 解析后为空');
      return dedupeTasks(arr, n, kinds, hist, new Set(todayTitles));
    }catch(e){ lastErr=e; }
  }
  console.warn('[growth] AI 生成失败，降级本地池：', lastErr&&lastErr.message);
  return fallbackTasks(n, kinds);
}

/* AI 结果去重：提示词只是"请求"，模型仍可能返回重名/同批重复的任务。
   重名项直接丢弃，数量不够就用内置池里近期没出现过的模板补齐——
   宁可换一条任务，也不要出现两张一模一样的卡片。 */
function dedupeTasks(arr, n, kinds, hist, todayUsed){
  const seen = new Set(todayUsed||[]);
  const out = [];
  for(const t of arr){
    if(!t || !t.title || seen.has(t.title)) continue;
    seen.add(t.title); out.push(t);
  }
  if(out.length < n){
    const fill = pickFreshList(FALLBACK_POOL, hist, seen, n - out.length, rngFor(ds(new Date())+'|fill|'+n));
    for(const t of fill) out.push({...t, kind:kinds[out.length]||'side'});
  }
  return out;
}

/* 兜底任务：任务池优先占坑，再用内置池；避让规则与起步/连锁共用 pickFreshList，
   免得"AI 失败时"和"起步/连锁时"各有一套，改一处漏一处。 */
function fallbackTasks(n, kinds){
  const today = ds(new Date());
  const hist = titleHistory(S.days, today);
  const todayUsed = new Set(((S.days[today] && S.days[today].slots) || [])
    .filter(sl=>sl.task).map(sl=>sl.task.title));
  const out = [];
  for(const t of (S.taskPool||[]).slice(0, n)) out.push({...t, kind:kinds[out.length]||'side'});
  if(out.length < n){
    const fill = pickFreshList(FALLBACK_POOL, hist, todayUsed, n - out.length, rngFor(today+'|fb|'+n));
    for(const t of fill) out.push({...t, kind:kinds[out.length]||'side'});
  }
  return out;
}

/* ── AI 复盘对话：宿主就周报与近期数据追问（如「为什么我周末总崩」）──
   纪律与 callReport() 相同：数字全部由本地算好（weekMetrics / dayStats / 完成凭证），
   提示词明确「不要编造数字」，AI 只负责解读。调用复用 chat()——同一条 Magpie
   同源代理通道、同一个 20 秒硬超时与 2 次重试，不另写调用逻辑。
   网关离线时不遮掩：返回 source:'offline'，由界面给出明确提示（不是空白报错）。 */

/* 单轮请求附带的对话上下文条数（本轮提问 + 最近历史 ≈ 10 条消息） */
const REVIEW_CONTEXT_MAX_MSGS = 10;

/* 近期完成记录：days 里的一句话凭证 + 完成的任务标题，供追问「为什么崩」时对时间 */
function reviewRecentDone(){
  const out=[];
  for(const d of Object.keys(S.days).sort().reverse()){
    for(const sl of S.days[d].slots){
      const t = sl.task;
      if((sl.status==='done'||sl.status==='partial') && t){
        out.push(`${d}「${t.title}」${sl.note?`：${sl.note}`:''}`);
      }
      if(out.length>=10) return out;
    }
  }
  return out;
}

/* 近期失效/收回：复盘「什么时候崩的」往往要看没做成的那几天 */
function reviewRecentMissed(){
  const out=[];
  for(const d of Object.keys(S.days).sort().reverse()){
    for(const sl of S.days[d].slots){
      const t = sl.task;
      if(t && (sl.status==='expired'||sl.status==='void')){
        out.push(`${d}「${t.title}」（${sl.status==='expired'?'失效':'收回'}）`);
      }
      if(out.length>=8) return out;
    }
  }
  return out;
}

/* 本轮请求的完整上下文。每轮都重新取数：宿主可能刚完成几个任务再看对话，
   给旧快照等于让 AI 拿着过期数字解读新问题。 */
function reviewContext(history){
  const m = weekMetrics(S, ds(new Date()), 7);
  const r = m.cur;

  const rows=[];
  for(let i=6;i>=0;i--){
    const d=new Date(); d.setDate(d.getDate()-i); const k=ds(d);
    const s=dayStats(S.days,k);
    rows.push(`${k}（周${'日一二三四五六'[d.getDay()]}）：完成 ${s.done}/${s.total}${s.expired?`，失效 ${s.expired}`:''}${s.void?`，突发收回 ${s.void}`:''}`);
  }

  const attrTxt = m.attrDelta
    ? Object.entries(m.attrDelta).map(([k,v])=>`${k}${v>=0?'+':''}${v}`).join('  ')
    : '（快照不足，暂无增量）';

  const recent = reviewRecentDone();
  const missed = reviewRecentMissed();

  const sys=`你是「个人成长系统」的AI复盘助手，系统流小说风格，正在与宿主对话。宿主会就周报和近期数据追问（如「为什么我周末总崩」）。要求：
- 用系统对宿主说话的口吻，务实不吹捧，直接回答问题
- **不要编造数字**：所有数量、比例只能用下面给出的数据；数据里没有的就说「数据里没有」
- 分析要落到具体日期与具体任务上，给出可执行的建议
- 回答简短（一般不超过 200 字），不要每次都重复完整周报`;

  const user=`【已核算的统计（只能引用这些数字）】
统计区间：${m.range.from} ~ ${m.range.to}
完成任务：${r.done} / ${r.total}（完成率 ${r.rate}%）
有效行动天数：${r.activeDays} / 7
连续打卡：${m.streak} 天
失效任务：${r.expired} 个；突发被收回：${r.voided} 个；停在半奖未收尾：${r.partial} 个
各维度投入次数：${Object.keys(r.byCat).length? Object.entries(r.byCat).map(([k,v])=>`${k} ${v}`).join('、') : '（无）'}
四维当前值：${JSON.stringify(S.player.attrs)}（Lv.${S.player.level}，EXP ${S.player.exp}/${expToNext(S.player.level)}）
本周属性增量：${attrTxt}
最薄弱的维度：${m.weakest||'（无）'}（当前 ${m.weakestValue}，${attrRank(m.weakestValue)} 级）
【近 7 天逐日】
${rows.join('\n')}
【近期完成记录】
${recent.join('\n')||'（无）'}
【近期失效/收回】
${missed.join('\n')||'（无）'}
【最近一次系统周报】
${(S.lastReport && S.lastReport.text) ? S.lastReport.text : '（尚未生成周报）'}`;

  const msgs=[{role:'system',content:sys},{role:'user',content:user}];
  for(const h of history.slice(-REVIEW_CONTEXT_MAX_MSGS)) msgs.push({role:h.role, content:h.text});
  return { messages: msgs, metrics: m };
}

/* 发起一轮复盘对话。history 含本轮提问（调用方先 push 再传入），
   取最后 ~10 条随请求发出。返回 { text, source }：
   source='ai' 正常；'offline' 网关不可用（调用方负责界面提示与降级回复）。 */
async function callReviewChat(history){
  const { messages, metrics } = reviewContext(history);
  try{
    const text = await chat(messages, 0.6);
    return { text, source:'ai', metrics };
  }catch(err){
    console.warn('[growth] 复盘对话 AI 失败（网关离线）：', err && err.message);
    return { text:'', source:'offline', metrics };
  }
}
