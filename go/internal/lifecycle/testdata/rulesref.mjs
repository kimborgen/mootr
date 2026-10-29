// The reference for rules_test.go: what src/rules.ts parseResetTime says for a matrix of limit messages and times, and
// how localeCompare orders window names. Run by the test (node, no daemon, TZ set by the test): argv[2] is the output
// file.
import { writeFileSync } from 'node:fs';

const { parseResetTime } = await import('../../../../src/rules.ts');

const messages = [
  '', 'no time here', 'try again at 3:25 PM', 'try again at 3:25 pm.', 'resets 15:25', 'resets at 9:05 a.m.', 'at 12:00 AM', 'at 12:30 PM',
  'at 13:00 PM', 'at 0:15 AM', 'at 24:00', 'at 7:61', 'at 7:05:30 PM', 'at 3:25 PM UTC', 'at 3:25 PM GMT', 'at 15:25Z', 'at 15:25 +02:00',
  'at 15:25 -0500', 'Try again at Oct 17th, 2026 9:05 AM', 'Try again at oct 3 2026 11:00 pm', 'Try again at Sept. 30, 2026 6:30 AM',
  'Try again at Feb 30, 2026 10:00', 'Try again at Oct 17th 9:05 AM', 'limit resets Dec 1 at 4:00 PM', 'at 4:00 PM', 'at 9:59',
  'at 10:00', 'at 11:30 PM', 'at 1:5 PM', 'ratio 10:30 of 99:99',
];
// 2026-10-21 10:00 and 22:30 local, and the first second after midnight.
const nows = [new Date(2026, 9, 21, 10, 0, 0).getTime(), new Date(2026, 9, 21, 22, 30, 0).getTime(), new Date(2026, 9, 22, 0, 0, 1).getTime()];
const reset = [];
for (const m of messages) for (const now of nows) reset.push({ m, now, at: parseResetTime(m, now) });

const names = ['five_hour', 'seven_day', 'seven_day_opus', '*', 'seven_day_sonnet', 'abc/five_hour', 'abc_five', 'Five_hour', 'five-hour', 'five2', 'five hour', 'x.y', 'x/y', 'x_y', 'A', 'a', 'b', 'B', '9', '10', '_', '$x'];
const sorted = [...names].sort((a, b) => a.localeCompare(b));
writeFileSync(process.argv[2], JSON.stringify({ reset, names, sorted }));
