import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCron } from "../mods/cockpit-automations/cronword.js";

test("cron schedules read as plain English", () => {
  const cases = {
    "51 16 * * 2": "Every Tuesday at 16:51",
    "0 9 * * *": "Every day at 09:00",
    "0 9 * * 1": "Every Monday at 09:00",
    "0 9 * * 7": "Every Sunday at 09:00",
    "0 * * * *": "Every hour, on the hour",
    "15 * * * *": "Every hour at 15 past",
    "* * * * *": "Every minute",
    "*/15 * * * *": "Every 15 minutes",
    "*/15 9-17 * * 1-5": "Every 15 minutes between 09:00 and 17:59, on weekdays",
    "0 9-17 * * *": "Every hour from 09:00 to 17:00",
    "0 */2 * * *": "Every 2 hours, on the hour",
    "30 9,17 * * *": "Every day at 09:30 and 17:30",
    "0 9 * * 0,6": "On weekends at 09:00",
    "0 9 * * 1,3,5": "On Mondays, Wednesdays and Fridays at 09:00",
    "0 0 1 * *": "On the 1st at 00:00",
    "0 0 1,15 * *": "On the 1st and 15th at 00:00",
    "0 0 1 * 1": "On the 1st or on Mondays at 00:00",
    "0 0 1 1 *": "On the 1st at 00:00, in January",
    "0 9 * 3-6 *": "Every day at 09:00, from March to June",
    "@daily": "Every day at 00:00",
    "@reboot": "When the Mac starts up",
  };
  for (const [schedule, text] of Object.entries(cases)) assert.equal(describeCron(schedule), text, schedule);
});

test("invalid schedules give null", () => {
  for (const schedule of ["", "0 9 * *", "60 * * * *", "* 24 * * *", "5-2 * * * *", "*/0 * * * *", "a b c d e"]) {
    assert.equal(describeCron(schedule), null, schedule);
  }
});
