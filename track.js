// DDD9 clan activity tracker.
// Runs on a schedule via GitHub Actions (see .github/workflows/track.yml).
// Polls the PS99 game API, compares against the last snapshot, and keeps
// a rolling history + computed stats (inactivity, streaks, hourly rate,
// short-window deltas) in tracking.json, which is committed back to the
// repo. The website reads tracking.json straight off GitHub's raw CDN.
//
// No npm dependencies on purpose (uses Node's built-in fetch), so this
// workflow needs no "npm install" step at all.

const fs = require('fs');
const path = require('path');

const CLAN_NAME = process.env.PS99_CLAN_NAME || 'DDD9';
const DATA_FILE = path.join(__dirname, 'tracking.json');
const POLL_INTERVAL_MINUTES = 10; // must match the cron schedule in track.yml
const MAX_SAMPLES = 160; // ~26.5 hours of history at a 10-minute interval

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { lastRun: null, members: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function minutesBetween(aIso, bIso) {
  return (new Date(bIso).getTime() - new Date(aIso).getTime()) / 60000;
}

// Finds the closest sample at or before `targetTs`, for computing deltas
// over fixed lookback windows (5m/30m/60m/12h).
function findSampleBefore(samples, targetTs) {
  let best = null;
  for (const s of samples) {
    const t = new Date(s.ts).getTime();
    if (t <= targetTs) {
      if (!best || t > new Date(best.ts).getTime()) best = s;
    }
  }
  return best;
}

async function main() {
  const res = await fetch(`https://ps99.biggamesapi.io/api/clan/${encodeURIComponent(CLAN_NAME)}`);
  if (!res.ok) throw new Error('clan API returned ' + res.status);
  const json = await res.json();
  if (json.status !== 'ok' || !json.data) throw new Error('clan not found: ' + CLAN_NAME);

  const clan = json.data;
  const members = clan.Members || [];
  const now = new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  const data = loadData();
  data.members = data.members || {};
  data.clanName = clan.Name;
  data.memberCount = members.length;

  const seenIds = new Set();

  for (const m of members) {
    const id = String(m.UserID);
    seenIds.add(id);
    const donated = m.Donated ?? m.CurrencyDonated ?? m.DiamondsDonated ?? m.GemsDonated ?? 0;

    let rec = data.members[id];
    if (!rec) {
      rec = {
        firstSeen: nowIso,
        lastActiveTs: nowIso,
        totalTrackedMinutes: 0,
        totalInactiveMinutes: 0,
        currentStreakMinutes: 0,
        bestStreakMinutes: 0,
        samples: [],
      };
    }

    const prevDonated = rec.samples.length ? rec.samples[rec.samples.length - 1].donated : donated;
    const wasActive = donated > prevDonated;

    rec.totalTrackedMinutes += POLL_INTERVAL_MINUTES;
    if (wasActive) {
      rec.lastActiveTs = nowIso;
      rec.currentStreakMinutes += POLL_INTERVAL_MINUTES;
      if (rec.currentStreakMinutes > rec.bestStreakMinutes) {
        rec.bestStreakMinutes = rec.currentStreakMinutes;
      }
    } else {
      rec.totalInactiveMinutes += POLL_INTERVAL_MINUTES;
      rec.currentStreakMinutes = 0;
    }

    rec.samples.push({ ts: nowIso, donated });
    if (rec.samples.length > MAX_SAMPLES) {
      rec.samples = rec.samples.slice(rec.samples.length - MAX_SAMPLES);
    }

    // Pre-compute the lookback deltas here so the website doesn't need to
    // crunch through the whole sample history itself.
    const windows = { d5m: 5, d30m: 30, d60m: 60, d12h: 720 };
    rec.deltas = {};
    for (const [key, mins] of Object.entries(windows)) {
      const target = nowMs - mins * 60000;
      const past = findSampleBefore(rec.samples, target);
      rec.deltas[key] = past ? donated - past.donated : null;
    }

    rec.donated = donated;
    rec.inactiveNowMinutes = Math.round(minutesBetween(rec.lastActiveTs, nowIso));
    rec.avgPerHour = rec.totalTrackedMinutes > 0
      ? Math.round((donated - (rec.samples[0] ? rec.samples[0].donated : donated)) / (rec.totalTrackedMinutes / 60))
      : 0;

    data.members[id] = rec;
  }

  data.lastRun = nowIso;
  saveData(data);
  console.log(`Tracked ${members.length} members for clan "${clan.Name}" at ${nowIso}`);
}

main().catch((err) => {
  console.error('Tracking run failed:', err);
  process.exit(1);
});
