import fs from 'fs';

const mergeResult = JSON.parse(
  fs.readFileSync(
    'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\merge-review-result.json',
    'utf-8',
  ),
);

const decisions = mergeResult.decisions.filter(
  (d) => d.should_merge && (d.merged_surface || '').trim().length <= 60,
);

// 按 leftId 的 offset.start 分组，看是否有多条决策引用了同一个左词 offset
const byLeftStart = new Map();
const byRightEnd = new Map();

for (const d of decisions) {
  const { start, end } = d.offsets || {};
  const leftKey = `${d.leftId}@${start}`;
  const rightKey = `${d.rightId}@${end}`;

  if (!byLeftStart.has(leftKey)) byLeftStart.set(leftKey, []);
  byLeftStart.get(leftKey).push(d);

  if (!byRightEnd.has(rightKey)) byRightEnd.set(rightKey, []);
  byRightEnd.get(rightKey).push(d);
}

const dupLeft = [...byLeftStart.entries()].filter(([, list]) => list.length > 1);
const dupRight = [...byRightEnd.entries()].filter(([, list]) => list.length > 1);

console.log('total merge decisions (within limit):', decisions.length);
console.log('left-offset keys reused by >1 decision:', dupLeft.length);
console.log('right-offset keys reused by >1 decision:', dupRight.length);

let dupLeftTotalExtra = 0;
for (const [, list] of dupLeft) dupLeftTotalExtra += list.length - 1;
let dupRightTotalExtra = 0;
for (const [, list] of dupRight) dupRightTotalExtra += list.length - 1;

console.log('extra decisions consumed by left-dup:', dupLeftTotalExtra);
console.log('extra decisions consumed by right-dup:', dupRightTotalExtra);

console.log('\nsample duplicate groups:');
dupLeft.slice(0, 5).forEach(([key, list]) => {
  console.log(`\nkey=${key}`);
  list.forEach((d) => console.log('  ->', d.rightId, JSON.stringify(d.offsets), d.merged_surface));
});
