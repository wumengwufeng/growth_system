'use strict';
/* state.js — 存档：localStorage 为主存，磁盘 data/growth.json 为备份。
   磁盘经 server.py 的 /api/save 读写：每次 save() 防抖 1.5s 后落盘；
   localStorage 为空时（清缓存/换浏览器）自动从磁盘恢复。 */

const KEY = 'growth_system_v1';

function migrate(s){
  if(!s.settings) s.settings={};
  const st=s.settings;
  if(!['light','dark','auto'].includes(st.theme)) st.theme='light';
  if(!['today','shop','log','data','settings'].includes(st.page)) st.page='today';
  if(!st.goal) st.goal='提升技术能力、保持身体健康、建立良好作息';
  if(!st.api) st.api='/api/v1';
  if(!st.key) st.key='magpie';
  if(!st.model) st.model='auto/deepseek-v4.1-flash';
  if(!st.dayStart) st.dayStart='09:00';
  if(!st.dayEnd) st.dayEnd='22:00';
  if(typeof st.sound!=='boolean') st.sound=true;
  if(!TONES[st.tone]) st.tone=DEFAULT_TONE;
  if(!s.player) s.player={ name:'宿主', level:1, exp:0, coins:0, attrs:{体质:0,智力:0,精神:0,自律:0} };
  if(!s.player.attrs) s.player.attrs={体质:0,智力:0,精神:0,自律:0};
  if(typeof s.player.title!=='string') s.player.title='';
  if(!Array.isArray(s.shop)) s.shop=[];
  if(!Array.isArray(s.taskPool)) s.taskPool=[];
  if(!s.stats) s.stats={done:0,expired:0};
  if(!s.log) s.log=[];
  if(!s.days) s.days={};
  if(typeof s.updatedAt!=='number') s.updatedAt=0;
  if(!Array.isArray(s.achievements)) s.achievements=[];
  if(!Array.isArray(s.streakClaimed)) s.streakClaimed=[];
  if(!Array.isArray(s.rankUps)) s.rankUps=[];
  ensureMainQuest(s);          // 主线任务：老存档补一个默认主线，进度按历史完成数回填
  if(s.mainQuest && s.mainQuest.progress===0 && s.stats && s.stats.done>0){
    s.mainQuest.progress = Math.min(s.mainQuest.target, s.stats.done);
  }
  return s;
}

function load(){
  try{
    const s = JSON.parse(localStorage.getItem(KEY));
    if(s && s.player && s.settings) return migrate(s);
  }catch(e){}
  return null;
}

function freshState(){
  return migrate({
    created: Date.now(),
    updatedAt: Date.now(),
    player: { name:'宿主', level:1, exp:0, coins:0, attrs:{体质:0,智力:0,精神:0,自律:0} },
    settings: { theme:'light', page:'today', goal:'提升技术能力、保持身体健康、建立良好作息',
      dayStart:'09:00', dayEnd:'22:00', sound:true, tone:DEFAULT_TONE },
    shop: [
      {name:'看一场想看的电影', cost:120},
      {name:'吃一顿惦记很久的大餐', cost:200},
      {name:'买一本想读的书', cost:80},
    ],
  });
}

let S = load() || freshState();

function save(){
  S.updatedAt = Date.now();   // 存档冲突时用新旧判断取舍
  localStorage.setItem(KEY, JSON.stringify(S));
  scheduleDiskSync();
}

/* ── 磁盘同步（P0：防丢档）── */
let diskTimer=null;
let diskMtime=null;   // 上次从磁盘读到/写入的 mtime，用于冲突检测
let diskConflict=false;

function scheduleDiskSync(){
  clearTimeout(diskTimer);
  diskTimer=setTimeout(syncDisk, 1500);
}

async function syncDisk(){
  if(diskConflict) return;  // 已提示过冲突，等用户决定（下次改动再试）
  try{
    const headers={'Content-Type':'application/json'};
    if(diskMtime) headers['X-Save-Mtime']=String(diskMtime);
    const r = await fetch('/api/save',{ method:'POST', headers, body: localStorage.getItem(KEY) });
    if(r.status===409){
      // 磁盘存档已被另一处改写（桌面版/浏览器版双开）：不覆盖，提示并采用较新的一份
      diskConflict=true;
      const theirs = await r.json().catch(()=>null);
      const mine = S;
      if(theirs && theirs.player && (theirs.updatedAt||0) > (mine.updatedAt||0)){
        S = migrate(theirs);
        localStorage.setItem(KEY, JSON.stringify(S));
        window.UI?.toast?.('检测到另一处更新的存档，已改用磁盘上的最新进度','gold');
        window.UI?.renderAll?.();
      }else{
        window.UI?.toast?.('存档冲突：磁盘上是另一份较早的进度，已保留当前这份','red');
      }
      diskMtime = +r.headers.get('X-Save-Mtime') || diskMtime;
      setTimeout(()=>{ diskConflict=false; }, 8000);
      return;
    }
    const m = r.headers.get('X-Save-Mtime');
    if(m) diskMtime = +m;
  }catch(e){ /* 无服务（file:// 直开）：静默停用磁盘备份 */ }
}

async function restoreFromDiskIfEmpty(){
  if(localStorage.getItem(KEY)) return;
  try{
    const r = await fetch('/api/save');
    if(!r.ok) return;
    const m = r.headers.get('X-Save-Mtime');
    if(m) diskMtime = +m;
    const s = await r.json();
    if(s && s.player && s.settings){
      S = migrate(s);
      // 恢复公告只在"最近 1 分钟没有同级公告"时写，避免反复/并发恢复把同一条刷进存档
      const dup = (S.log||[]).some(e=>e.txt==='检测到磁盘存档，已自动恢复。' && Date.now()-e.t < 60000);
      if(!dup) log('检测到磁盘存档，已自动恢复。','up');
    }
  }catch(e){ /* file:// 直开或服务未启动：忽略，走全新档案 */ }
}

/* ── 运行环境探测：本机版(有 Python 后端) vs 纯静态托管(如 GitHub Pages) ──
   静态托管时 /api/* 全部 404：磁盘备份静默停用（已有降级），AI 也不可用。
   这个标志只用于"给访客一句解释"，不改变任何业务逻辑。 */
let STATIC_HOST = false;
async function detectHost(){
  try{
    const r = await fetch('/api/ping', { method:'GET' });
    if(r.ok){
      const j = await r.json();
      STATIC_HOST = !(j && j.app);
    }else{
      STATIC_HOST = true;   // 404：纯静态托管
    }
  }catch(e){
    STATIC_HOST = true;     // file:// 直开或断网
  }
  return STATIC_HOST;
}

/* 首次访问（或访客清过缓存）且任务尚未发布时，立刻补一个起步任务。
   目的：静态 demo 里"窗口还没到点"会让访客看到空页面，直接关掉。
   只补一次：靠 dayRec.demoStarter 标记，不写进 stats，不影响宿主真实存档的判定。 */
async function seedDemoStarter(){
  const today = ds(new Date());
  const day = S.days[today];
  if(!day) return false;
  if(day.demoStarter) return false;                                  // 已经补过
  if(day.slots.some(sl=>sl.status!=='waiting' && sl.status!=='void')) return false;  // 已有真任务
  const live = day.slots.filter(sl=>sl.status==='waiting');
  if(!live.length) return false;
  const nowM = nowMin();
  const at = Math.min(...live.map(sl=>sl.at));
  if(at <= nowM) return false;                                       // 已到点，正常流程会发
  const hist = titleHistory(S.days, today);
  const pool = FALLBACK_POOL.filter(t=>t.difficulty===1 && t.minutes<=15);
  const pick = pickFreshTemplate(pool, hist, new Set(), rngFor(today+'|demo')) || FALLBACK_POOL[0];
  const slot = {
    at: Math.max(0, nowM - 1), kind:'side', status:'pending',
    issuedAt: Date.now(), demo:true,
    task: {...pick, kind:'side'},
    deadline: Math.min(new Date(today+'T23:59:00').getTime(), Date.now()+120*60000),
  };
  day.slots.push(slot);
  day.demoStarter = true;
  const r = rewards(slot.task);
  log(`访客模式：系统先给一条轻量任务热身——「${slot.task.title}」（奖励 EXP+${r.exp} ◈+${r.coins} ${slot.task.category}+${r.attr}）。剩下的仍按不定时发布。`,'up');
  save();
  return true;
}

/* ── 面板心跳（判断"这段提醒有没有人接收"）──
   单独存一个键，刻意不写进存档：心跳每轮结算都写，若塞进存档会把 updatedAt 一直顶新，
   双开时的 409 冲突判定就跟着失真（后台旧标签页的心跳会被当成"更新的进度"）。 */
const SEEN_KEY = 'growth_system_lastseen';
function lastSeenAt(){
  try{ const v = +(localStorage.getItem(SEEN_KEY)||0); return v>0?v:0; }catch(e){ return 0; }
}
function markSeen(nowMs){
  try{ localStorage.setItem(SEEN_KEY, String(nowMs||Date.now())); }catch(e){}
}

/* ── 复盘对话历史（独立键，不进存档）──
   与心跳同理：对话是界面层的轻量数据，塞进 S 会让每次聊天都顶新 updatedAt，
   双开时的 409 冲突判定跟着失真，还会白跑磁盘同步。只存已落定的消息
   （宿主提问 + 系统成功回复）；离线报错气泡是临时的，不入档。 */
const REVIEW_KEY = 'growth_system_review_chat';
const REVIEW_MAX_MSGS = 60;
function loadReviewChat(){
  try{
    const v = JSON.parse(localStorage.getItem(REVIEW_KEY));
    if(Array.isArray(v)) return v.filter(m=>m && (m.role==='user'||m.role==='assistant') && typeof m.text==='string' && m.text.trim());
  }catch(e){}
  return [];
}
function saveReviewChat(msgs){
  try{ localStorage.setItem(REVIEW_KEY, JSON.stringify(msgs.slice(-REVIEW_MAX_MSGS))); }catch(e){}
}
function clearReviewChat(){
  try{ localStorage.removeItem(REVIEW_KEY); }catch(e){}
}

/* ── 公告记录（状态的一部分）── */
function log(txt, kind='sys'){
  S.log.unshift({t:Date.now(), txt, kind});
  if(S.log.length>300) S.log.length=300;
}
