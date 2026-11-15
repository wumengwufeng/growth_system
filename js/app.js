'use strict';
/* app.js — 入口：磁盘恢复 → 绑定 → 首次结算 → 定时器。
   控制台可用 GROWTH.selftest() 校验核心逻辑。 */

window.GROWTH={ selftest, settle, planDay, get S(){return S;} };

/* settle 是 async：不接 catch 会把异常吞成"界面一片安静"（曾掩盖 TDZ 缺陷）。 */
function runSettle(){
  return settle().catch(err=>{
    console.error('[growth] 结算失败：', err);
    if(S.settings.sound!==undefined) window.UI?.toast?.('结算异常，任务可能未更新（详见控制台）','red');
  }).then(()=>UI.renderAll());
}

(async function boot(){
  await restoreFromDiskIfEmpty();
  bindSettings();
  if(!S.log.length) log('系统绑定成功。宿主，从今天起，你的成长由本系统记录与量化。');
  showPage(S.settings.page);
  runSettle();
  UI.renderAll();
  setInterval(runSettle, 30000);
  setInterval(()=>{ // 秒级倒计时
    document.querySelectorAll('[data-deadline]').forEach(el=>{ el.textContent=fmtRemain(+el.dataset.deadline); });
    // 新任务完成冷却：倒计时走完就把按钮放出来（不重渲染，避免打断阅读）
    document.querySelectorAll('[data-arm]').forEach(el=>{
      const left = Math.ceil((+el.dataset.arm - Date.now())/1000);
      if(left > 0){ el.textContent = `完成（${left}s）`; }
      else{
        el.disabled = false; el.textContent = el.dataset.label || '完成';
        el.dataset.act = 'done'; delete el.dataset.arm;
      }
    });
  }, 1000);
})();
