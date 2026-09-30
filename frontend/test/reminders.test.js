const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

loadModules('reminders.js');
const { dueReminders } = global.TheBusReminders;

test('dueReminders fires when the soonest upcoming arrival is at or under the threshold', () => {
  const reminders = [{ stopId: 'S1', stopName: 'Avalon Publix', minutesBefore: 5 }];
  const byStop = { S1: [{ minutesUntil: 12 }, { minutesUntil: 4 }, { minutesUntil: 20 }] };
  const due = dueReminders(reminders, byStop);
  assert.equal(due.length, 1);
  assert.equal(due[0].reminder.stopId, 'S1');
  assert.equal(due[0].minutesUntil, 4); // soonest, and <= 5
});

test('dueReminders does NOT fire when the soonest arrival is still beyond the threshold', () => {
  const reminders = [{ stopId: 'S1', stopName: 'Avalon Publix', minutesBefore: 5 }];
  const byStop = { S1: [{ minutesUntil: 8 }, { minutesUntil: 14 }] };
  assert.deepEqual(dueReminders(reminders, byStop), []);
});

test('dueReminders treats a DUE-now (0 min) arrival as firing, and ignores arrivals already in the past', () => {
  const reminders = [{ stopId: 'S1', stopName: 'X', minutesBefore: 5 }];
  const byStop = { S1: [{ minutesUntil: -3 }, { minutesUntil: 0 }] };
  const due = dueReminders(reminders, byStop);
  assert.equal(due.length, 1);
  assert.equal(due[0].minutesUntil, 0);
});

test('dueReminders skips a stop with no predictions and handles multiple reminders independently', () => {
  const reminders = [
    { stopId: 'S1', stopName: 'A', minutesBefore: 5 },
    { stopId: 'S2', stopName: 'B', minutesBefore: 10 },
    { stopId: 'S3', stopName: 'C', minutesBefore: 5 },
  ];
  const byStop = {
    S1: [],                       // no live data -> not due
    S2: [{ minutesUntil: 9 }],    // 9 <= 10 -> due
    S3: [{ minutesUntil: 30 }],   // 30 > 5 -> not due
  };
  const due = dueReminders(reminders, byStop);
  assert.deepEqual(due.map((d) => d.reminder.stopId), ['S2']);
});
