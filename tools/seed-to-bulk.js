'use strict';
/* 把 seeds/*.json 转成设置页「批量导入」的粘贴文本。
   用法：node tools/seed-to-bulk.js [seeds/taskpool-shijie.json] > pool-bulk.txt
   格式：标题 | 分类 | 难度 | 分钟 | 描述
   描述里若出现竖线会破坏解析——种子本身不许有，这里再做一次替换兜底。 */
const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, '..', 'seeds', 'taskpool-shijie.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const tasks = Array.isArray(data) ? data : data.tasks;
if (!Array.isArray(tasks)) throw new Error('种子格式不对：缺少 tasks 数组');

const CATS = ['体质', '智力', '精神', '自律'];
const lines = [];
for (const t of tasks) {
  const title = String(t.title || '').trim().slice(0, 40);
  if (!title) continue;
  const cat = CATS.includes(t.category) ? t.category : '自律';
  const diff = Math.min(3, Math.max(1, +t.difficulty || 2));
  const min = Math.min(120, Math.max(5, +t.minutes || 30));
  const desc = String(t.desc || '').replace(/[|｜]/g, '，').slice(0, 200);
  lines.push([title, cat, diff, min, desc].join(' | '));
}
process.stdout.write(lines.join('\n') + '\n');
console.error(`[seed-to-bulk] ${lines.length} 条 ← ${path.basename(file)}`);