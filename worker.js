const WEBSITE_ORIGIN = "https://judy-ai-backend-live.djskinking.workers.dev";
const CACHE_TTL = 900;

async function sportmonksRequest(env, path, params = {}, options = {}) {
  const apiUrl = new URL("https://api.sportmonks.com/v3/football/" + path);
  for (const [key, value] of Object.entries(params)) apiUrl.searchParams.set(key, value);
  apiUrl.searchParams.sort();

  const cache = caches.default;
  const cacheKey = new Request("https://judy-ai-cache.example/sportmonks/api-v1/" +
    encodeURIComponent(path) + "?" + apiUrl.searchParams.toString());
  const cached = options.bypassCache ? null : await cache.match(cacheKey);
  if (cached) {
    const body = await cached.json();
    if (body && Object.prototype.hasOwnProperty.call(body, "data")) return body.data;
  }

  const cooldownKey = new Request("https://judy-ai-cache.example/sportmonks/cooldown");
  const cooldown = await cache.match(cooldownKey);
  if (cooldown) {
    const info = await cooldown.json();
    const error = new Error("Sportmonks rate limit cooldown is active; retry later.");
    error.status = 429;
    error.retryAfterSeconds = info.retryAfterSeconds || 60;
    error.details = info;
    throw error;
  }

  apiUrl.searchParams.set("api_token", env.SPORTMONKS_API_TOKEN);
  const response = await fetch(apiUrl.toString(), { headers: { "Accept": "application/json" } });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); }
  catch { throw new Error("Sportmonks returned unreadable data (HTTP " + response.status + ")."); }

  if (!response.ok) {
    const error = new Error("Sportmonks request failed (HTTP " + response.status + ").");
    error.status = response.status;
    error.details = body;
    if (response.status === 429) {
      const headerDelay = Number(response.headers.get("Retry-After"));
      const retryAfterSeconds = Number.isFinite(headerDelay) && headerDelay > 0 ? headerDelay : 60;
      error.retryAfterSeconds = retryAfterSeconds;
      await cache.put(cooldownKey, new Response(JSON.stringify({
        retryAfterSeconds,
        message: "A short cooldown prevents repeated requests while Sportmonks rate limits the account."
      }), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=" + retryAfterSeconds } }));
    }
    throw error;
  }

  // Historical fixture and team-history responses are effectively immutable.
  // Cache them for 30 days; keep fixture detail and date listings fresher.
  const ttl = path.startsWith("fixtures/between/") ? 2592000 :
    (/^fixtures\/\d+$/.test(path) ? 21600 : 300);
  if (!options.bypassCache) await cache.put(cacheKey, new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=" + ttl }
  }));
  return body.data;
}



function poissonProb(lambda, goals) {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= goals; i++) p *= lambda / i;
  return p;
}

function topScoreOptions(homeLambda, awayLambda) {
  const options = [];
  for (let home = 0; home <= 8; home++) {
    for (let away = 0; away <= 8; away++) {
      options.push({
        score: home + "-" + away,
        probability: poissonProb(homeLambda, home) * poissonProb(awayLambda, away)
      });
    }
  }
  return options.sort((a, b) => b.probability - a.probability).slice(0, 2)
    .map((item, index) => ({
      rank: index + 1,
      score: item.score,
      probability: Number((item.probability * 100).toFixed(2))
    }));
}

function goalsForAgainst(fixture, teamId, period) {
  const scores = Array.isArray(fixture.scores) ? fixture.scores : [];
  const periodRows = scores.filter(s => s.description === period);
  if (!periodRows.length) return null;
  const teamRow = periodRows.find(s => Number(s.participant_id) === Number(teamId));
  if (!teamRow || !teamRow.score) return null;
  const teamSide = teamRow.score.participant;
  const opponentRow = periodRows.find(s => s.score && s.score.participant !== teamSide);
  if (!opponentRow || !Number.isFinite(Number(teamRow.score.goals)) ||
      !Number.isFinite(Number(opponentRow.score.goals))) return null;
  return {
    scored: Number(teamRow.score.goals),
    conceded: Number(opponentRow.score.goals)
  };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function leagueGoalAverage(forms, leagueId, period, kickoff, minimumFixtures = 6) {
  if (leagueId === null || leagueId === undefined) return { average: null, fixtures: 0, used: false };
  const unique = new Map();
  for (const item of forms) {
    if (Number(item.leagueId) !== Number(leagueId) || !item[period] || !item.fixtureId) continue;
    if (!unique.has(String(item.fixtureId))) unique.set(String(item.fixtureId), item);
  }
  let weightedGoals = 0;
  let totalWeight = 0;
  for (const item of unique.values()) {
    const matchDate = new Date(String(item.date || "").replace(" ", "T") + "Z");
    const ageDays = Number.isNaN(matchDate.getTime()) ? 0 :
      Math.max(0, (kickoff.getTime() - matchDate.getTime()) / 86400000);
    const weight = Math.exp(-Math.LN2 * ageDays / 45);
    weightedGoals += (item[period].scored + item[period].conceded) * weight;
    totalWeight += 2 * weight;
  }
  const fixtures = unique.size;
  const avg = totalWeight ? weightedGoals / totalWeight : null;
  const used = fixtures >= minimumFixtures && Number.isFinite(avg) && avg > 0;
  return { average: used ? avg : null, fixtures, used };
}

function leagueAdjustedExpectedGoals(teamAttack, opponentConceded, leagueAverage, baselineExpectedGoals) {
  if (!Number.isFinite(teamAttack) || !Number.isFinite(opponentConceded) ||
      !Number.isFinite(leagueAverage) || leagueAverage <= 0 ||
      !Number.isFinite(baselineExpectedGoals)) return null;
  const attackStrength = teamAttack / leagueAverage;
  const opponentDefensiveWeakness = opponentConceded / leagueAverage;
  const rawAdjusted = Math.max(0.05, Math.min(4.5,
    leagueAverage * attackStrength * opponentDefensiveWeakness));
  // Shrink the noisy league adjustment 75% toward the proven V1 baseline.
  const blended = baselineExpectedGoals + 0.25 * (rawAdjusted - baselineExpectedGoals);
  return Math.max(0.05, Math.min(4.5, blended));
}

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": WEBSITE_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

function nairobiDateOffset(days = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + days));
  return date.toISOString().slice(0, 10);
}

function trackingKey(fixtureId) { return "prediction:" + String(fixtureId); }

async function storePrediction(env, result) {
  if (!env.JUDY_PREDICTIONS) return "storage_not_configured";
  const key = trackingKey(result.fixture.id);
  // Freeze the first pre-kickoff prediction for an unbiased performance record.
  // Refreshing a fixture must never overwrite its original prediction.
  const existing = await env.JUDY_PREDICTIONS.get(key);
  if (existing) {
    // Preserve the original pre-kickoff prediction, but enrich older records
    // that were saved before Match Intelligence was introduced.
    try {
      const record = JSON.parse(existing);
      let changed = false;
      if (record && !record.teamIntelligence && result.teamIntelligence) {
        record.teamIntelligence = result.teamIntelligence;
        record.teamIntelligenceAddedAt = new Date().toISOString();
        changed = true;
      }
      if (record && !record.playerWatch && result.playerWatch) {
        record.playerWatch = result.playerWatch;
        record.playerWatchAddedAt = new Date().toISOString();
        changed = true;
      }
      if (changed) await env.JUDY_PREDICTIONS.put(key, JSON.stringify(record));
    } catch {}
    return "already_saved";
  }
  const record = {
    fixtureId: result.fixture.id,
    fixture: result.fixture,
    capturedAt: new Date().toISOString(),
    status: "pending",
    predictions: result.predictions,
    baselineV1: result.baselineV1,
    modelDiagnostics: result.modelDiagnostics,
    teamIntelligence: result.teamIntelligence || null,
    playerWatch: result.playerWatch || null,
    sampleSize: result.sampleSize || null,
    confidence: result.confidence || null,
    experimental: result.experimental === true,
    validationStatus: result.validationStatus || null,
    note: result.note || null,
    actual: null,
    evaluation: null,
    lastCheckedAt: null
  };
  await env.JUDY_PREDICTIONS.put(key, JSON.stringify(record));
  return "saved";
}

async function savedPredictionPayload(env, fixtureId) {
  if (!env.JUDY_PREDICTIONS) return null;
  const raw = await env.JUDY_PREDICTIONS.get(trackingKey(fixtureId));
  if (!raw) return null;
  const record = JSON.parse(raw);
  if (!record || !record.predictions || !record.fixture) return null;
  return {
    app: "JUDY AI",
    success: true,
    historical: true,
    fixture: record.fixture,
    predictions: record.predictions,
    baselineV1: record.baselineV1 || null,
    modelDiagnostics: record.modelDiagnostics || null,
    teamIntelligence: record.teamIntelligence || null,
    playerWatch: record.playerWatch || null,
    sampleSize: record.sampleSize || { home: "—", away: "—" },
    confidence: record.confidence || "Recorded pre-kickoff",
    experimental: record.experimental === true,
    validationStatus: record.validationStatus || null,
    note: record.note || "This is the original prediction saved before kick-off.",
    tracking: { saveStatus: "already_saved", recordStatus: record.status || "pending", actual: record.actual || null, evaluation: record.evaluation || null, completedAt: record.completedAt || null }
  };
}

function isFixtureFinished(fixture) {
  const state = fixture && fixture.state ? fixture.state : {};
  const values = [state.state, state.name, state.short_name, state.developer_name]
    .filter(Boolean).map(value => String(value).toLowerCase());
  return values.some(value =>
    value === "ft" || value === "aet" || value === "ft_pen" ||
    value.includes("full time") || value.includes("finished") ||
    value.includes("after extra time") || value.includes("after penalties")
  );
}

function scoreHits(options, actual) {
  if (!Array.isArray(options) || !actual) return { exact: null, topTwo: null };
  return {
    exact: Boolean(options[0] && options[0].score === actual),
    topTwo: options.some(option => option.score === actual)
  };
}

function evaluateTrackedRecord(record, actualFT, actualHT) {
  const v1FT = scoreHits(record.baselineV1 && record.baselineV1.fullTime && record.baselineV1.fullTime.options, actualFT);
  const v2FT = scoreHits(record.predictions && record.predictions.fullTime && record.predictions.fullTime.options, actualFT);
  const v1HT = scoreHits(record.baselineV1 && record.baselineV1.halfTime && record.baselineV1.halfTime.options, actualHT);
  const v2HT = scoreHits(record.predictions && record.predictions.halfTime && record.predictions.halfTime.options, actualHT);
  return {
    v1: { fullTime: v1FT, halfTime: v1HT },
    v2_1: { fullTime: v2FT, halfTime: v2HT }
  };
}

export default {
  async scheduled(controller, env, ctx) {
    const run = {
      app: "JUDY AI",
      status: "running",
      scheduledTime: controller && controller.scheduledTime ? new Date(controller.scheduledTime).toISOString() : null,
      cron: controller && controller.cron ? controller.cron : null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      predictionsScanned: 0,
      dueFixtures: 0,
      fixturesChecked: 0,
      fixturesCompleted: 0,
      fixturesStillPending: 0,
      errors: [],
      rateLimited: false,
      limitReached: false
    };
    let cursor;
    let stop = false;
    try {
      if (!env.SPORTMONKS_API_TOKEN || !env.JUDY_PREDICTIONS) {
        run.status = "configuration_missing";
        run.errors.push("Sportmonks token or JUDY_PREDICTIONS binding is missing.");
        return;
      }
      // Prepare today's remaining fixtures and tomorrow's fixtures in small batches.
      // Each date has its own persistent cursor so hourly runs can resume safely.
      run.autoPredictionDates = [];
      run.autoPredictionGenerated = 0;
      run.autoPredictionInsufficientHistory = 0;
      run.autoPredictionFailed = 0;
      const autoDateResults = [];
      for (const dayOffset of [0, 1]) {
        const targetDate = nairobiDateOffset(dayOffset);
        const batchKey = "autopregen:" + targetDate;
        let batch = await env.JUDY_PREDICTIONS.get(batchKey);
        batch = batch ? JSON.parse(batch) : null;
        if (!batch || !Array.isArray(batch.fixtureIds)) {
          const fixtureIds = [];
          let pageNumber = 1;
          let pageRows = [];
          do {
            pageRows = await sportmonksRequest(env, "fixtures/date/" + targetDate, {
              include: "participants;league;state", per_page: "50", page: String(pageNumber)
            });
            for (const fixture of Array.isArray(pageRows) ? pageRows : []) {
              const kickoff = new Date(String(fixture.starting_at || "").replace(" ", "T") + "Z").getTime();
              if (fixture.id && Number.isFinite(kickoff) && kickoff > Date.now()) fixtureIds.push(String(fixture.id));
            }
            pageNumber++;
          } while (Array.isArray(pageRows) && pageRows.length === 50 && pageNumber <= 6);
          batch = {
            date: targetDate,
            createdAt: new Date().toISOString(),
            fixtureIds: [...new Set(fixtureIds)],
            nextIndex: 0,
            generated: 0,
            insufficientHistory: 0,
            failed: 0,
            pageLimitReached: pageNumber > 6 && pageRows.length === 50,
            status: fixtureIds.length ? "in_progress" : "no_upcoming_fixtures"
          };
        }

        const generatedBefore = batch.generated;
        const insufficientBefore = batch.insufficientHistory;
        const failedBefore = batch.failed;
        const endIndex = Math.min(batch.nextIndex + 3, batch.fixtureIds.length);
        for (let index = batch.nextIndex; index < endIndex; index++) {
          const fixtureId = batch.fixtureIds[index];
          let retryCurrent = false;
          try {
            const response = await this.fetch(new Request(
              WEBSITE_ORIGIN + "/api/predictions?fixtureId=" + encodeURIComponent(fixtureId),
              { method: "GET" }
            ), env, ctx);
            const result = await response.json();
            if (response.status === 429 || (result && result.providerStatus === 429)) {
              retryCurrent = true;
              run.rateLimited = true;
              run.errors.push("Auto prediction batch for " + targetDate + " paused by Sportmonks rate limiting; it will retry next scheduled run.");
            } else if (response.ok && result && result.success === true && result.predictions) {
              if (result.tracking && result.tracking.saveStatus === "already_saved") {
                // An existing pre-kickoff record is preserved and not counted as a new prediction.
              } else {
                batch.generated++;
              }
            } else if (result && result.status === "insufficient_history") {
              batch.insufficientHistory++;
            } else if (response.status === 409) {
              // Fixture has already kicked off; it is safely excluded.
            } else {
              batch.failed++;
              run.errors.push("Auto prediction " + fixtureId + ": " +
                String(result && (result.error || result.message) || "Prediction unavailable").slice(0, 180));
            }
          } catch (error) {
            retryCurrent = error && error.status === 429;
            if (retryCurrent) run.rateLimited = true;
            else {
              batch.failed++;
              run.errors.push("Auto prediction " + fixtureId + ": " +
                String(error && error.message || error).slice(0, 180));
            }
          }
          if (retryCurrent) break;
          batch.nextIndex = index + 1;
        }
        if (batch.nextIndex >= batch.fixtureIds.length) batch.status = "completed";
        else if (batch.status !== "no_upcoming_fixtures") batch.status = "in_progress";
        batch.updatedAt = new Date().toISOString();
        await env.JUDY_PREDICTIONS.put(batchKey, JSON.stringify(batch));

        const generatedThisRun = batch.generated - generatedBefore;
        const insufficientThisRun = batch.insufficientHistory - insufficientBefore;
        const failedThisRun = batch.failed - failedBefore;
        run.autoPredictionGenerated += generatedThisRun;
        run.autoPredictionInsufficientHistory += insufficientThisRun;
        run.autoPredictionFailed += failedThisRun;
        run.autoPredictionDates.push(targetDate);
        autoDateResults.push({
          date: targetDate,
          fixturesFound: batch.fixtureIds.length,
          generatedTotal: batch.generated,
          insufficientHistoryTotal: batch.insufficientHistory,
          failedTotal: batch.failed,
          status: batch.status,
          nextIndex: batch.nextIndex,
          pageLimitReached: Boolean(batch.pageLimitReached)
        });
        if (run.rateLimited) break;
      }
      run.autoPredictionByDate = autoDateResults;
      run.autoPredictionDate = autoDateResults.length ? autoDateResults[autoDateResults.length - 1].date : null;
      run.autoPredictionFixturesFound = autoDateResults.reduce((sum, item) => sum + item.fixturesFound, 0);
      run.autoPredictionStatus = run.rateLimited ? "paused_rate_limited" :
        (autoDateResults.every(item => item.status === "completed" || item.status === "no_upcoming_fixtures")
          ? "completed" : "in_progress");
      run.autoPredictionNextIndex = autoDateResults.reduce((sum, item) => sum + item.nextIndex, 0);
      run.autoPredictionPageLimitReached = autoDateResults.some(item => item.pageLimitReached);
      do {
        const page = await env.JUDY_PREDICTIONS.list({ prefix: "prediction:", limit: 100, cursor });
        for (const key of page.keys || []) {
          if (run.fixturesChecked >= 20) {
            run.limitReached = true;
            stop = true;
            break;
          }
          run.predictionsScanned++;
          try {
            const raw = await env.JUDY_PREDICTIONS.get(key.name);
            if (!raw) continue;
            const record = JSON.parse(raw);
            if (record.status === "completed") continue;
            const kickoffTime = new Date(String(record.fixture && record.fixture.startingAt || "").replace(" ", "T") + "Z").getTime();
            if (!Number.isFinite(kickoffTime) || kickoffTime > Date.now()) continue;
            run.dueFixtures++;
            const fixture = await sportmonksRequest(env, "fixtures/" + record.fixtureId, {
              include: "participants;scores;state;league"
            }, { bypassCache: true });
            run.fixturesChecked++;
            record.lastCheckedAt = new Date().toISOString();
            const participants = Array.isArray(fixture.participants) ? fixture.participants : [];
            const home = participants.find(p => p.meta && p.meta.location === "home");
            const away = participants.find(p => p.meta && p.meta.location === "away");
            if (!home || !away) {
              run.fixturesStillPending++;
              run.errors.push("Fixture " + record.fixtureId + ": home/away participants missing.");
              await env.JUDY_PREDICTIONS.put(key.name, JSON.stringify(record));
              continue;
            }

            // Capture and evaluate the half-time score as soon as Sportmonks publishes it.
            const homeHT = goalsForAgainst(fixture, home.id, "1ST_HALF");
            const awayHT = goalsForAgainst(fixture, away.id, "1ST_HALF");
            const actualHT = homeHT && awayHT ? homeHT.scored + "-" + awayHT.scored : null;
            record.actual = record.actual || { fullTime: null, halfTime: null };
            if (actualHT && record.actual.halfTime !== actualHT) {
              record.actual.halfTime = actualHT;
              record.halfTimeCheckedAt = new Date().toISOString();
              record.evaluation = evaluateTrackedRecord(record, record.actual.fullTime || null, actualHT);
              run.fixturesHalfTimeEvaluated = (run.fixturesHalfTimeEvaluated || 0) + 1;
            }

            if (!isFixtureFinished(fixture)) {
              run.fixturesStillPending++;
              await env.JUDY_PREDICTIONS.put(key.name, JSON.stringify(record));
              continue;
            }

            const homeFT = goalsForAgainst(fixture, home.id, "CURRENT");
            const awayFT = goalsForAgainst(fixture, away.id, "CURRENT");
            if (!homeFT || !awayFT) {
              run.fixturesStillPending++;
              run.errors.push("Fixture " + record.fixtureId + ": full-time scores unavailable.");
              await env.JUDY_PREDICTIONS.put(key.name, JSON.stringify(record));
              continue;
            }
            const actualFT = homeFT.scored + "-" + awayFT.scored;
            record.status = "completed";
            record.completedAt = new Date().toISOString();
            record.actual = { fullTime: actualFT, halfTime: actualHT || record.actual.halfTime || null };
            record.evaluation = evaluateTrackedRecord(record, actualFT, record.actual.halfTime);
            await env.JUDY_PREDICTIONS.put(key.name, JSON.stringify(record));
            run.fixturesCompleted++;
          } catch (error) {
            if (error && error.status === 429) {
              run.rateLimited = true;
              run.errors.push("Sportmonks rate limit reached; remaining fixtures will retry next run.");
              stop = true;
              break;
            }
            run.errors.push("Fixture " + key.name + ": " + String(error && error.message || error).slice(0, 240));
          }
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor && !stop);
      if (run.status === "running") run.status = run.errors.length ? "completed_with_errors" : "success";
    } catch (error) {
      run.status = "failed";
      run.errors.push(String(error && error.message || error).slice(0, 300));
    } finally {
      run.finishedAt = new Date().toISOString();
      if (env.JUDY_PREDICTIONS) {
        try {
          await env.JUDY_PREDICTIONS.put("cron:latest", JSON.stringify(run));
        } catch (error) {
          console.error("JUDY AI cron diagnostic write failed:", error && error.message || error);
        }
      }
      console.log("JUDY AI cron run:", JSON.stringify(run));
    }
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": WEBSITE_ORIGIN,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    if (url.pathname === "/api/cron-status") {
      if (request.method !== "GET") return reply({ error: "GET method required" }, 405);
      if (!env.JUDY_PREDICTIONS) return reply({
        app: "JUDY AI", success: false, error: "Prediction storage is not configured"
      }, 503);
      try {
        const raw = await env.JUDY_PREDICTIONS.get("cron:latest");
        return reply({
          app: "JUDY AI",
          success: true,
          mode: "cron_diagnostics",
          message: raw ? "Latest scheduled-run diagnostic found." : "No scheduled-run diagnostic has been recorded yet. Wait for the next hourly trigger.",
          latestRun: raw ? JSON.parse(raw) : null
        });
      } catch (error) {
        return reply({ app: "JUDY AI", success: false, error: "Could not read Cron diagnostics", details: error.message }, 500);
      }
    }

    if (url.pathname === "/api/diagnostics") {
      return reply({
        app: "JUDY AI",
        sportmonksTokenConfigured: Boolean(env.SPORTMONKS_API_TOKEN),
        predictionStorageConfigured: Boolean(env.JUDY_PREDICTIONS),
        availableBindingNames: Object.keys(env)
      });
    }

    if (url.pathname === "/api/tracking") {
      if (request.method !== "GET") return reply({ error: "GET method required" }, 405);
      if (!env.JUDY_PREDICTIONS) return reply({
        app: "JUDY AI", success: false, error: "Prediction storage is not configured",
        requiredBinding: "JUDY_PREDICTIONS"
      }, 503);
      try {
        const records = [];
        let cursor;
        do {
          const page = await env.JUDY_PREDICTIONS.list({ prefix: "prediction:", limit: 100, cursor });
          for (const key of page.keys || []) {
            const raw = await env.JUDY_PREDICTIONS.get(key.name);
            if (raw) records.push(JSON.parse(raw));
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
        records.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
        const completed = records.filter(record => record.status === "completed");
        const metric = (model, period, hitType) => {
          const rows = completed.filter(record => record.evaluation && record.evaluation[model] &&
            record.evaluation[model][period] && record.evaluation[model][period][hitType] !== null);
          const hits = rows.filter(record => record.evaluation[model][period][hitType] === true).length;
          return { hits, total: rows.length, accuracyPercent: rows.length ? Number((hits / rows.length * 100).toFixed(2)) : null };
        };
        return reply({
          app: "JUDY AI", success: true, mode: "prediction_tracking",
          totalPredictions: records.length, pendingPredictions: records.length - completed.length,
          completedPredictions: completed.length,
          metrics: {
            v1: {
              fullTimeExact: metric("v1", "fullTime", "exact"),
              fullTimeTopTwo: metric("v1", "fullTime", "topTwo"),
              halfTimeExact: metric("v1", "halfTime", "exact"),
              halfTimeTopTwo: metric("v1", "halfTime", "topTwo")
            },
            v2_1: {
              fullTimeExact: metric("v2_1", "fullTime", "exact"),
              fullTimeTopTwo: metric("v2_1", "fullTime", "topTwo"),
              halfTimeExact: metric("v2_1", "halfTime", "exact"),
              halfTimeTopTwo: metric("v2_1", "halfTime", "topTwo")
            }
          },
          records
        });
      } catch (error) {
        return reply({ app: "JUDY AI", success: false, error: "Could not read prediction tracking data", details: error.message }, 500);
      }
    }

    if (url.pathname === "/api/backtest") {
      if (request.method !== "GET") return reply({ error: "GET method required" }, 405);
      if (!env.SPORTMONKS_API_TOKEN) return reply({ error: "Sportmonks API token is not configured" }, 500);

      let rawIds = (url.searchParams.get("fixtureIds") || "").split(",").map(v => v.trim()).filter(Boolean);
      const dateParam = url.searchParams.get("date");
      const autoMode = url.searchParams.get("auto") === "1";
      const beforeParam = url.searchParams.get("before") || dateParam;
      const lookbackDays = Math.max(1, Math.min(100, Number(url.searchParams.get("lookbackDays") || 30)));
      const limit = Math.max(1, Math.min(5, Number(url.searchParams.get("limit") || 5)));
      if (rawIds.length && (dateParam || autoMode || url.searchParams.has("before") || rawIds.length > 5 || rawIds.some(id => !/^[0-9]+$/.test(id)))) {
        return reply({ error: "Use either fixtureIds, date, or auto historical search—not more than one mode." }, 400);
      }
      if (autoMode && (!beforeParam || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(beforeParam))) {
        return reply({ error: "Automatic search requires before=YYYY-MM-DD." }, 400);
      }
      if (!rawIds.length && !autoMode && (!dateParam || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(dateParam))) {
        return reply({ error: "Provide fixtureIds, a past date, or auto=1 with before=YYYY-MM-DD." }, 400);
      }

      async function sportmonks(path, params = {}) {
        return sportmonksRequest(env, path, params);
      }

      function weightedAverage(values, weights) {
        const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
        return totalWeight ? values.reduce((sum, value, index) => sum + value * weights[index], 0) / totalWeight : null;
      }

      function periodAverages(form, key, preferredVenue, kickoff) {
        const venueRows = form.filter(item => item.venue === preferredVenue && item[key]);
        const useVenueSplit = venueRows.length >= 3;
        const selected = useVenueSplit ? venueRows : form.filter(item => item[key]);
        const rows = selected.map(item => {
          const matchDate = new Date(String(item.date || "").replace(" ", "T") + "Z");
          const ageDays = Number.isNaN(matchDate.getTime()) ? 0 :
            Math.max(0, (kickoff.getTime() - matchDate.getTime()) / 86400000);
          return { stats: item[key], weight: Math.exp(-Math.LN2 * ageDays / 45) };
        });
        const weights = rows.map(row => row.weight);
        return {
          scored: weightedAverage(rows.map(row => row.stats.scored), weights),
          conceded: weightedAverage(rows.map(row => row.stats.conceded), weights),
          venueMatches: venueRows.length,
          venueSplitUsed: useVenueSplit
        };
      }

      function scoreText(home, away) {
        return home && away ? home.scored + "-" + away.scored : null;
      }

      const tested = [];
      let searchSummary = null;
      try {
        if (!rawIds.length && autoMode) {
          const end = new Date(beforeParam + "T23:59:59Z");
          const start = new Date(end.getTime() - (lookbackDays - 1) * 86400000).toISOString().slice(0, 10);
          const rangeFixtures = await sportmonks("fixtures/between/" + start + "/" + beforeParam, {
            include: "participants;league;scores;state", per_page: "50", order: "desc"
          });
          const finished = (Array.isArray(rangeFixtures) ? rangeFixtures : []).filter(f => {
            const stateName = f.state && String(f.state.name || "").toLowerCase();
            const kickoffTime = new Date(String(f.starting_at || "").replace(" ", "T") + "Z").getTime();
            const hasFullTimeScore = Array.isArray(f.scores) && f.scores.some(score =>
              (score.description === "CURRENT" || score.description === "2ND_HALF") &&
              score.score && score.score.goals !== null && score.score.goals !== undefined &&
              Number.isFinite(Number(score.score.goals))
            );
            return hasFullTimeScore && Number.isFinite(kickoffTime) &&
              kickoffTime <= end.getTime() &&
              !["not started", "ns", "live", "in play", "1st half", "2nd half", "half-time"].includes(stateName);
          }).sort((a, b) =>
            new Date(String(b.starting_at).replace(" ", "T") + "Z").getTime() -
            new Date(String(a.starting_at).replace(" ", "T") + "Z").getTime()
          );
          rawIds = finished.slice(0, limit).map(f => String(f.id));
          searchSummary = {
            mode: "automatic_date_range",
            from: start,
            through: beforeParam,
            lookbackDays,
            eligibleFixturesFoundInReturnedPage: finished.length,
            selectedFixtures: rawIds.length,
            note: "Searches one Sportmonks date-range page (up to 50 fixtures), then backtests the most recent eligible completed fixtures."
          };
        } else if (!rawIds.length) {
          const dayFixtures = await sportmonks("fixtures/date/" + dateParam, {
            include: "participants;league;scores;state", per_page: "50"
          });
          const finished = (Array.isArray(dayFixtures) ? dayFixtures : []).filter(f => {
            const stateName = f.state && String(f.state.name || "").toLowerCase();
            const ft = Array.isArray(f.scores) && f.scores.some(score =>
              (score.description === "CURRENT" || score.description === "2ND_HALF") &&
              score.score && score.score.goals !== null && score.score.goals !== undefined &&
              Number.isFinite(Number(score.score.goals))
            );
            return ft && !["not started", "ns", "live", "in play", "1st half", "2nd half", "half-time"].includes(stateName);
          });
          rawIds = finished.slice(0, limit).map(f => String(f.id));
        }
        if (!rawIds.length) {
          return reply({
            app: "JUDY AI", success: true, mode: "historical_backtest",
            warning: autoMode
              ? "No completed fixtures with full-time score data were found in the requested historical date range."
              : "No completed fixtures with full-time score data were found for this date.",
            search: searchSummary,
            requestedFixtures: 0, testedFixtures: 0, skippedFixtures: [],
            metrics: { fullTimeExactScoreHits: 0, fullTimeExactScoreAccuracyPercent: null,
              fullTimeTopTwoHits: 0, fullTimeTopTwoAccuracyPercent: null,
              halfTimeFixturesWithResults: 0, halfTimeExactScoreHits: 0,
              halfTimeExactScoreAccuracyPercent: null, halfTimeTopTwoHits: 0,
              halfTimeTopTwoAccuracyPercent: null }, results: []
          });
        }
        for (const fixtureId of rawIds) {
          const target = await sportmonks("fixtures/" + fixtureId, {
            include: "participants;league;scores;state"
          });
          if (!target || !Array.isArray(target.participants)) {
            tested.push({ fixtureId, status: "fixture_not_found" });
            continue;
          }
          const homeTeam = target.participants.find(p => p.meta && p.meta.location === "home");
          const awayTeam = target.participants.find(p => p.meta && p.meta.location === "away");
          if (!homeTeam || !awayTeam) {
            tested.push({ fixtureId, status: "team_data_missing" });
            continue;
          }

          const kickoff = new Date(String(target.starting_at).replace(" ", "T") + "Z");
          if (Number.isNaN(kickoff.getTime())) {
            tested.push({ fixtureId, status: "invalid_kickoff" });
            continue;
          }
          const endDate = target.starting_at.slice(0, 10);
          const startDate = new Date(kickoff.getTime() - 180 * 86400000).toISOString().slice(0, 10);
          // Keep provider traffic sequential; cached history prevents repeat downloads.
          const homeHistory = await sportmonks("fixtures/between/" + startDate + "/" + endDate + "/" + homeTeam.id, {
            include: "scores;participants;league", per_page: "50", order: "desc"
          });
          const awayHistory = await sportmonks("fixtures/between/" + startDate + "/" + endDate + "/" + awayTeam.id, {
            include: "scores;participants;league", per_page: "50", order: "desc"
          });

          function recentForm(rows, teamId) {
            return (Array.isArray(rows) ? rows : [])
              .filter(f => Number(f.id) !== Number(fixtureId) &&
                new Date(String(f.starting_at || "").replace(" ", "T") + "Z").getTime() < kickoff.getTime())
              .map(f => {
                const participant = Array.isArray(f.participants)
                  ? f.participants.find(p => Number(p.id) === Number(teamId)) : null;
                return {
                  fixtureId: f.id,
                  leagueId: f.league_id || (f.league && f.league.id) || null,
                  ft: goalsForAgainst(f, teamId, "CURRENT") || goalsForAgainst(f, teamId, "2ND_HALF"),
                  ht: goalsForAgainst(f, teamId, "1ST_HALF"),
                  date: f.starting_at,
                  venue: participant && participant.meta ? participant.meta.location : null
                };
              })
              .filter(f => f.ft)
              .sort((a, b) => String(b.date).localeCompare(String(a.date)))
              .slice(0, 8);
          }

          const homeForm = recentForm(homeHistory, homeTeam.id);
          const awayForm = recentForm(awayHistory, awayTeam.id);
          if (homeForm.length < 3 || awayForm.length < 3) {
            tested.push({
              fixtureId, match: target.name, status: "insufficient_history",
              sampleSize: { home: homeForm.length, away: awayForm.length }
            });
            continue;
          }

          const hft = periodAverages(homeForm, "ft", "home", kickoff);
          const aft = periodAverages(awayForm, "ft", "away", kickoff);
          const hht = periodAverages(homeForm, "ht", "home", kickoff);
          const aht = periodAverages(awayForm, "ht", "away", kickoff);
          const expectedGoals = (attack, defence) => Math.max(0.05, Math.min(4.5, (attack + defence) / 2));
          const v1FtHome = expectedGoals(hft.scored, aft.conceded);
          const v1FtAway = expectedGoals(aft.scored, hft.conceded);
          const htReady = hht.scored !== null && aht.scored !== null &&
            hht.conceded !== null && aht.conceded !== null;
          const v1HtHome = htReady ? expectedGoals(hht.scored, aht.conceded) : null;
          const v1HtAway = htReady ? expectedGoals(aht.scored, hht.conceded) : null;
          const leagueId = target.league_id || (target.league && target.league.id);
          const leagueFt = leagueGoalAverage(homeForm.concat(awayForm), leagueId, "ft", kickoff);
          const leagueHt = leagueGoalAverage(homeForm.concat(awayForm), leagueId, "ht", kickoff);
          const v2FtHome = leagueFt.used ? leagueAdjustedExpectedGoals(hft.scored, aft.conceded, leagueFt.average, v1FtHome) : v1FtHome;
          const v2FtAway = leagueFt.used ? leagueAdjustedExpectedGoals(aft.scored, hft.conceded, leagueFt.average, v1FtAway) : v1FtAway;
          const v2HtHome = htReady ? (leagueHt.used ? leagueAdjustedExpectedGoals(hht.scored, aht.conceded, leagueHt.average, v1HtHome) : v1HtHome) : null;
          const v2HtAway = htReady ? (leagueHt.used ? leagueAdjustedExpectedGoals(aht.scored, hht.conceded, leagueHt.average, v1HtAway) : v1HtAway) : null;
          const ftOptions = topScoreOptions(v1FtHome, v1FtAway);
          const htOptions = htReady ? topScoreOptions(v1HtHome, v1HtAway) : null;
          const v2FtOptions = topScoreOptions(v2FtHome, v2FtAway);
          const v2HtOptions = htReady ? topScoreOptions(v2HtHome, v2HtAway) : null;

          const actualHomeFT = goalsForAgainst(target, homeTeam.id, "CURRENT") ||
            goalsForAgainst(target, homeTeam.id, "2ND_HALF");
          const actualAwayFT = goalsForAgainst(target, awayTeam.id, "CURRENT") ||
            goalsForAgainst(target, awayTeam.id, "2ND_HALF");
          const actualHomeHT = goalsForAgainst(target, homeTeam.id, "1ST_HALF");
          const actualAwayHT = goalsForAgainst(target, awayTeam.id, "1ST_HALF");
          const actualFT = scoreText(actualHomeFT, actualAwayFT);
          const actualHT = scoreText(actualHomeHT, actualAwayHT);

          if (!actualFT) {
            tested.push({ fixtureId, match: target.name, status: "actual_result_not_available" });
            continue;
          }
          tested.push({
            fixtureId,
            match: target.name,
            kickoff: target.starting_at,
            league: target.league && target.league.name,
            status: "tested",
            sampleSize: { home: homeForm.length, away: awayForm.length },
            actual: { fullTime: actualFT, halfTime: actualHT },
            predicted: { fullTime: ftOptions, halfTime: htOptions },
            hits: {
              fullTimeExact: ftOptions[0] && ftOptions[0].score === actualFT,
              fullTimeTopTwo: ftOptions.some(option => option.score === actualFT),
              halfTimeExact: actualHT ? Boolean(htOptions && htOptions[0] && htOptions[0].score === actualHT) : null,
              halfTimeTopTwo: actualHT ? Boolean(htOptions && htOptions.some(option => option.score === actualHT)) : null
            },
            comparisonV2_1: {
              predicted: { fullTime: v2FtOptions, halfTime: v2HtOptions },
              hits: {
                fullTimeExact: v2FtOptions[0] && v2FtOptions[0].score === actualFT,
                fullTimeTopTwo: v2FtOptions.some(option => option.score === actualFT),
                halfTimeExact: actualHT ? Boolean(v2HtOptions && v2HtOptions[0] && v2HtOptions[0].score === actualHT) : null,
                halfTimeTopTwo: actualHT ? Boolean(v2HtOptions && v2HtOptions.some(option => option.score === actualHT)) : null
              },
              leagueBaseline: {
                fullTimeAverageGoalsPerTeam: leagueFt.average === null ? null : Number(leagueFt.average.toFixed(3)),
                fullTimeLeagueFixtures: leagueFt.fixtures,
                fullTimeAdjustmentUsed: leagueFt.used,
                halfTimeAverageGoalsPerTeam: leagueHt.average === null ? null : Number(leagueHt.average.toFixed(3)),
                halfTimeLeagueFixtures: leagueHt.fixtures,
                halfTimeAdjustmentUsed: leagueHt.used
              }
            }
          });
        }

        const completed = tested.filter(item => item.status === "tested");
        const countHits = key => completed.filter(item => item.hits[key] === true).length;
        const rate = hits => completed.length ? Number((hits / completed.length * 100).toFixed(2)) : null;
        const htCompleted = completed.filter(item => item.actual.halfTime);
        const htHits = htCompleted.filter(item => item.hits.halfTimeExact === true).length;
        const htTopTwoHits = htCompleted.filter(item => item.hits.halfTimeTopTwo === true).length;
        const v2Hits = key => completed.filter(item => item.comparisonV2_1 && item.comparisonV2_1.hits[key] === true).length;
        const v2HtHits = htCompleted.filter(item => item.comparisonV2_1 && item.comparisonV2_1.hits.halfTimeExact === true).length;
        const v2HtTopTwoHits = htCompleted.filter(item => item.comparisonV2_1 && item.comparisonV2_1.hits.halfTimeTopTwo === true).length;
        return reply({
          app: "JUDY AI",
          success: true,
          mode: "historical_backtest_v1_vs_v2",
          engineComparison: "V1 baseline versus V2.1 conservative league-adjusted Poisson",
          warning: "Experimental paired comparison only. Both models use only matches strictly before each fixture's kickoff. V2 league averages are estimated from recent available fixtures involving the two teams in the same league, not a complete league-wide sample.",
          requestedFixtures: rawIds.length,
          search: searchSummary,
          testedFixtures: completed.length,
          skippedFixtures: tested.filter(item => item.status !== "tested"),
          metricsV1: {
            fullTimeExactScoreHits: countHits("fullTimeExact"),
            fullTimeExactScoreAccuracyPercent: rate(countHits("fullTimeExact")),
            fullTimeTopTwoHits: countHits("fullTimeTopTwo"),
            fullTimeTopTwoAccuracyPercent: rate(countHits("fullTimeTopTwo")),
            halfTimeFixturesWithResults: htCompleted.length,
            halfTimeExactScoreHits: htHits,
            halfTimeExactScoreAccuracyPercent: htCompleted.length ? Number((htHits / htCompleted.length * 100).toFixed(2)) : null,
            halfTimeTopTwoHits: htTopTwoHits,
            halfTimeTopTwoAccuracyPercent: htCompleted.length ? Number((htTopTwoHits / htCompleted.length * 100).toFixed(2)) : null
          },
          metricsV2: {
            fullTimeExactScoreHits: v2Hits("fullTimeExact"),
            fullTimeExactScoreAccuracyPercent: rate(v2Hits("fullTimeExact")),
            fullTimeTopTwoHits: v2Hits("fullTimeTopTwo"),
            fullTimeTopTwoAccuracyPercent: rate(v2Hits("fullTimeTopTwo")),
            halfTimeFixturesWithResults: htCompleted.length,
            halfTimeExactScoreHits: v2HtHits,
            halfTimeExactScoreAccuracyPercent: htCompleted.length ? Number((v2HtHits / htCompleted.length * 100).toFixed(2)) : null,
            halfTimeTopTwoHits: v2HtTopTwoHits,
            halfTimeTopTwoAccuracyPercent: htCompleted.length ? Number((v2HtTopTwoHits / htCompleted.length * 100).toFixed(2)) : null
          },
          results: completed
        });
      } catch (error) {
        return reply({
          error: error.message || "Historical backtest failed",
          providerStatus: error.status || null,
          retryAfterSeconds: error.retryAfterSeconds || null,
          details: error.details || null
        }, error.status || 502);
      }
    }

    if (url.pathname === "/api/predictions") {
      if (request.method !== "GET") return reply({ error: "GET method required" }, 405);
      if (!env.SPORTMONKS_API_TOKEN) return reply({ error: "Sportmonks API token is not configured" }, 500);
      const fixtureId = url.searchParams.get("fixtureId");
      if (!fixtureId || !/^\d+$/.test(fixtureId)) {
        return reply({ error: "A valid fixtureId is required" }, 400);
      }

      const cache = caches.default;
      const cacheKey = new Request("https://judy-ai-cache.example/sportmonks/predictions/v4/" + fixtureId);
      const cached = await cache.match(cacheKey);
      if (cached) {
        const cachedResult = await cached.clone().json();
        const cachedKickoff = new Date(String(cachedResult.fixture && cachedResult.fixture.startingAt || "").replace(" ", "T") + "Z").getTime();
        if (Number.isFinite(cachedKickoff) && cachedKickoff <= Date.now()) {
          const saved = await savedPredictionPayload(env, fixtureId);
          if (saved) return reply(saved);
          return reply({
            app: "JUDY AI", success: false, error: "No pre-kickoff prediction was saved for this match.",
            fixtureId, startingAt: cachedResult.fixture.startingAt
          }, 409);
        }
        let trackingSaveStatus = "storage_not_configured";
        if (env.JUDY_PREDICTIONS && cachedResult && cachedResult.fixture &&
            new Date(String(cachedResult.fixture.startingAt).replace(" ", "T") + "Z").getTime() > Date.now()) {
          try { trackingSaveStatus = await storePrediction(env, cachedResult); }
          catch { trackingSaveStatus = "save_failed"; }
        }
        cachedResult.tracking = { saveStatus: trackingSaveStatus };
        return reply(cachedResult);
      }

      async function sportmonks(path, params = {}) {
        return sportmonksRequest(env, path, params);
      }

      try {
        const target = await sportmonks("fixtures/" + fixtureId, { include: "participants;league;sidelined.player;sidelined.type;lineups.player;lineups.type;lineups.position" });
        if (!target || !Array.isArray(target.participants)) {
          return reply({ error: "Fixture or participant data was not found." }, 404);
        }
        const homeTeam = target.participants.find(p => p.meta && p.meta.location === "home");
        const awayTeam = target.participants.find(p => p.meta && p.meta.location === "away");
        if (!homeTeam || !awayTeam) return reply({ error: "Could not identify both teams for this fixture." }, 422);

        const kickoff = new Date(String(target.starting_at).replace(" ", "T") + "Z");
        if (Number.isNaN(kickoff.getTime())) return reply({ error: "Fixture kick-off date is invalid." }, 422);
        if (kickoff.getTime() <= Date.now()) {
          const saved = await savedPredictionPayload(env, fixtureId);
          if (saved) return reply(saved);
          return reply({
            app: "JUDY AI", success: false, error: "No pre-kickoff prediction was saved for this match.",
            fixtureId: target.id, startingAt: target.starting_at
          }, 409);
        }
        const endDate = target.starting_at.slice(0, 10);
        const start = new Date(kickoff.getTime() - 180 * 86400000).toISOString().slice(0, 10);

        const [homeHistory, awayHistory] = await Promise.all([
          sportmonks("fixtures/between/" + start + "/" + endDate + "/" + homeTeam.id, {
            include: "scores;participants;league", per_page: "50", order: "desc"
          }),
          sportmonks("fixtures/between/" + start + "/" + endDate + "/" + awayTeam.id, {
            include: "scores;participants;league", per_page: "50", order: "desc"
          })
        ]);

        function recentForm(rows, teamId) {
          return (Array.isArray(rows) ? rows : [])
            .filter(f => Number(f.id) !== Number(fixtureId) &&
              new Date(String(f.starting_at || "").replace(" ", "T") + "Z").getTime() < kickoff.getTime())
            .map(f => {
              const participant = Array.isArray(f.participants)
                ? f.participants.find(p => Number(p.id) === Number(teamId))
                : null;
              return {
                fixtureId: f.id,
                leagueId: f.league_id || (f.league && f.league.id) || null,
                ft: goalsForAgainst(f, teamId, "CURRENT") || goalsForAgainst(f, teamId, "2ND_HALF"),
                ht: goalsForAgainst(f, teamId, "1ST_HALF"),
                date: f.starting_at,
                venue: participant && participant.meta ? participant.meta.location : null
              };
            })
            .filter(f => f.ft)
            .sort((a, b) => String(b.date).localeCompare(String(a.date)))
            .slice(0, 8);
        }

        const homeForm = recentForm(homeHistory, homeTeam.id);
        const awayForm = recentForm(awayHistory, awayTeam.id);
        if (homeForm.length < 3 || awayForm.length < 3) {
          return reply({
            app: "JUDY AI",
            success: false,
            status: "insufficient_history",
            message: "Not enough recent completed matches with score data to produce a responsible prediction.",
            sampleSize: { home: homeForm.length, away: awayForm.length },
            minimumRequired: 3
          }, 200);
        }

        function weightedAverage(values, weights) {
          const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
          return totalWeight ? values.reduce((sum, value, index) => sum + value * weights[index], 0) / totalWeight : null;
        }

        function periodAverages(form, key, preferredVenue) {
          const venueRows = form.filter(item => item.venue === preferredVenue && item[key]);
          const useVenueSplit = venueRows.length >= 3;
          const selected = useVenueSplit ? venueRows : form.filter(item => item[key]);
          const rows = selected.map(item => {
            const matchDate = new Date(String(item.date || "").replace(" ", "T") + "Z");
            const ageDays = Number.isNaN(matchDate.getTime())
              ? 0
              : Math.max(0, (kickoff.getTime() - matchDate.getTime()) / 86400000);
            // A 45-day half-life gives recent performances more influence without discarding older matches.
            const weight = Math.exp(-Math.LN2 * ageDays / 45);
            return { stats: item[key], weight };
          });
          const weights = rows.map(row => row.weight);
          return {
            scored: weightedAverage(rows.map(row => row.stats.scored), weights),
            conceded: weightedAverage(rows.map(row => row.stats.conceded), weights),
            matches: rows.length,
            venueMatches: venueRows.length,
            venueSplitUsed: useVenueSplit
          };
        }
        const hft = periodAverages(homeForm, "ft", "home");
        const aft = periodAverages(awayForm, "ft", "away");
        const hht = periodAverages(homeForm, "ht", "home");
        const aht = periodAverages(awayForm, "ht", "away");

        function expectedGoals(teamAttack, opponentDefence) {
          return Math.max(0.05, Math.min(4.5, (teamAttack + opponentDefence) / 2));
        }
        const v1FtHome = expectedGoals(hft.scored, aft.conceded);
        const v1FtAway = expectedGoals(aft.scored, hft.conceded);
        const htReady = hht.scored !== null && aht.scored !== null &&
          hht.conceded !== null && aht.conceded !== null;
        const v1HtHome = htReady ? expectedGoals(hht.scored, aht.conceded) : null;
        const v1HtAway = htReady ? expectedGoals(aht.scored, hht.conceded) : null;
        const leagueId = target.league_id || (target.league && target.league.id);
        const leagueFt = leagueGoalAverage(homeForm.concat(awayForm), leagueId, "ft", kickoff);
        const leagueHt = leagueGoalAverage(homeForm.concat(awayForm), leagueId, "ht", kickoff);
        const ftHome = leagueFt.used ? leagueAdjustedExpectedGoals(hft.scored, aft.conceded, leagueFt.average, v1FtHome) : v1FtHome;
        const ftAway = leagueFt.used ? leagueAdjustedExpectedGoals(aft.scored, hft.conceded, leagueFt.average, v1FtAway) : v1FtAway;
        const htHome = htReady ? (leagueHt.used ? leagueAdjustedExpectedGoals(hht.scored, aht.conceded, leagueHt.average, v1HtHome) : v1HtHome) : null;
        const htAway = htReady ? (leagueHt.used ? leagueAdjustedExpectedGoals(aht.scored, hht.conceded, leagueHt.average, v1HtAway) : v1HtAway) : null;
        const sampleSize = { home: homeForm.length, away: awayForm.length };
        function buildTeamIntelligence(form, venue) {
          const lastFive = form.slice(0, 5).map(item => {
            const outcome = item.ft.scored > item.ft.conceded ? "W" :
              item.ft.scored < item.ft.conceded ? "L" : "D";
            return {
              date: item.date,
              fixtureId: item.fixtureId,
              venue: item.venue || "Unknown",
              goalsFor: item.ft.scored,
              goalsAgainst: item.ft.conceded,
              outcome
            };
          });
          const venueRows = form.filter(item => item.venue === venue);
          const selected = venueRows.length >= 2 ? venueRows : form;
          const wins = selected.filter(item => item.ft.scored > item.ft.conceded).length;
          const draws = selected.filter(item => item.ft.scored === item.ft.conceded).length;
          const losses = selected.filter(item => item.ft.scored < item.ft.conceded).length;
          return {
            matchesAnalysed: form.length,
            lastFive,
            venueSplit: venueRows.length >= 2 ? venue : "All venues (insufficient venue sample)",
            venueMatches: selected.length,
            wins, draws, losses,
            averageGoalsFor: Number(average(selected.map(item => item.ft.scored)).toFixed(2)),
            averageGoalsAgainst: Number(average(selected.map(item => item.ft.conceded)).toFixed(2)),
            firstHalfDataAvailable: form.filter(item => item.ht).length
          };
        }
        const teamIntelligence = {
          home: buildTeamIntelligence(homeForm, "home"),
          away: buildTeamIntelligence(awayForm, "away"),
          source: "Sportmonks completed fixture score history",
          limitations: [
            "This section describes recent results only; it does not confirm injuries, suspensions or starting lineups.",
            "Venue splits use all-venue data when fewer than two matching home/away samples are available."
          ]
        };
        const sidelinedRows = Array.isArray(target.sidelined) ? target.sidelined : [];
        const todayNairobi = nairobiDateOffset(0);
        const activeAbsences = sidelinedRows.filter(row => row && row.completed === false && (!row.end_date || String(row.end_date).slice(0, 10) >= todayNairobi));
        const lineupRows = Array.isArray(target.lineups) ? target.lineups : [];
        const playerLabel = row => (row.player && (row.player.display_name || row.player.common_name || row.player.name)) || row.player_name || "Name unavailable";
        const confirmed = !!(target.metadata && target.metadata.lineup_confirmed === true);
        const playerWatch = {
          status: activeAbsences.length || lineupRows.length ? "available" : "limited",
          absences: activeAbsences.map(row => ({ player: playerLabel(row), teamId: row.team_id || null, reason: row.type && (row.type.name || row.type.code) || "Reason not supplied", startDate: row.start_date || null, endDate: row.end_date || null, sourceStatus: "Sportmonks sidelined record" })),
          lineups: { status: lineupRows.length ? (confirmed ? "confirmed" : "predicted_or_unconfirmed") : "not_available", label: lineupRows.length ? (confirmed ? "Confirmed lineups" : "Expected / unconfirmed lineup data") : "Not available yet", home: lineupRows.filter(row => Number(row.team_id) === Number(homeTeam.id) && Number(row.type_id) === 11).map(row => ({ name: playerLabel(row), position: row.position && row.position.name || "Position unavailable" })), away: lineupRows.filter(row => Number(row.team_id) === Number(awayTeam.id) && Number(row.type_id) === 11).map(row => ({ name: playerLabel(row), position: row.position && row.position.name || "Position unavailable" })) },
          source: "Sportmonks fixture sidelined and lineup data",
          note: "Only provider-listed absences and lineup entries are shown. Missing information is not inferred."
        };
        const confidence = Math.min(homeForm.length, awayForm.length) >= 6 ? "Moderate" : "Low";
        const result = {
          app: "JUDY AI",
          success: true,
          experimental: true,
          validationStatus: "V2.1 not yet validated; paired historical comparison available",
          provider: "Sportmonks",
          fixture: {
            id: target.id,
            name: target.name,
            startingAt: target.starting_at,
            league: target.league && target.league.name,
            homeTeam: homeTeam.name,
            awayTeam: awayTeam.name
          },
          sampleSize,
          teamIntelligence,
          playerWatch,
          venueAnalysis: {
            homeTeamHomeMatches: hft.venueMatches,
            awayTeamAwayMatches: aft.venueMatches,
            homeVenueSplitUsed: hft.venueSplitUsed,
            awayVenueSplitUsed: aft.venueSplitUsed,
            recencyWeighting: "45-day half-life"
          },
          confidence,
          predictions: {
            fullTime: {
              method: leagueFt.used
                ? "V2.1 conservative league-adjusted Poisson model using recency-weighted attack and defensive-concession strengths plus a recent same-league scoring baseline"
                : "V2.1 fallback to V1 recency-weighted Poisson because fewer than 6 recent same-league fixtures were available",
              expectedGoals: { home: Number(ftHome.toFixed(2)), away: Number(ftAway.toFixed(2)) },
              options: topScoreOptions(ftHome, ftAway)
            },
            halfTime: htReady ? {
              method: leagueHt.used
                ? "V2.1 conservative league-adjusted first-half Poisson model using a recent same-league first-half scoring baseline"
                : "V2.1 fallback to V1 first-half Poisson because fewer than 6 same-league first-half fixtures were available",
              expectedGoals: { home: Number(htHome.toFixed(2)), away: Number(htAway.toFixed(2)) },
              options: topScoreOptions(htHome, htAway)
            } : null
          },
          baselineV1: {
            fullTime: { expectedGoals: { home: Number(v1FtHome.toFixed(2)), away: Number(v1FtAway.toFixed(2)) }, options: topScoreOptions(v1FtHome, v1FtAway) },
            halfTime: htReady ? { expectedGoals: { home: Number(v1HtHome.toFixed(2)), away: Number(v1HtAway.toFixed(2)) }, options: topScoreOptions(v1HtHome, v1HtAway) } : null
          },
          modelDiagnostics: {
            engine: "V2.1",
            fullTimeLeagueAverageGoalsPerTeam: leagueFt.average === null ? null : Number(leagueFt.average.toFixed(3)),
            fullTimeLeagueFixturesInSample: leagueFt.fixtures,
            fullTimeLeagueAdjustmentUsed: leagueFt.used,
            halfTimeLeagueAverageGoalsPerTeam: leagueHt.average === null ? null : Number(leagueHt.average.toFixed(3)),
            halfTimeLeagueFixturesInSample: leagueHt.fixtures,
            halfTimeLeagueAdjustmentUsed: leagueHt.used,
            leagueBaselineNote: "Recent same-league fixtures found in the two teams' histories; this is a limited proxy, not a complete league-wide average."
          },
          note: "V2.1 is experimental and not yet validated. It adjusts expected goals using a recent same-league scoring baseline when at least 6 unique fixtures are available; otherwise it falls back to V1. Probabilities are estimates, not guarantees."
        };
        let trackingSaveStatus = "storage_not_configured";
        if (env.JUDY_PREDICTIONS) {
          try { trackingSaveStatus = await storePrediction(env, result); }
          catch { trackingSaveStatus = "save_failed"; }
        }
        result.tracking = { saveStatus: trackingSaveStatus };
        ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=21600" }
        })));
        return reply(result);
      } catch (error) {
        return reply({
          error: error.message || "Could not build fixture analysis",
          providerStatus: error.status || null,
          details: error.details || null
        }, error.status || 502);
      }
    }

    if (url.pathname !== "/api/matches") {
      return reply({ error: "Route not found" }, 404);
    }

    if (request.method !== "GET") {
      return reply({ error: "GET method required" }, 405);
    }

    if (!env.SPORTMONKS_API_TOKEN) {
      return reply({ error: "Sportmonks API token is not configured" }, 500);
    }

    const date = url.searchParams.get("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reply({ error: "Date must use YYYY-MM-DD format" }, 400);
    }

    const cache = caches.default;
    const cacheKey = new Request("https://judy-ai-cache.example/sportmonks/matches/" + date);
    const cached = await cache.match(cacheKey);

    if (cached) {
      return new Response(cached.body, {
        status: cached.status,
        headers: {
          ...Object.fromEntries(cached.headers),
          "Access-Control-Allow-Origin": WEBSITE_ORIGIN
        }
      });
    }

    const apiUrl = new URL("https://api.sportmonks.com/v3/football/fixtures/date/" + date);
    apiUrl.searchParams.set("api_token", env.SPORTMONKS_API_TOKEN);
    apiUrl.searchParams.set("include", "participants;league;state;venue");
    apiUrl.searchParams.set("per_page", "50");

    try {
      const upstream = await fetch(apiUrl.toString(), {
        headers: { "Accept": "application/json" }
      });

      const raw = await upstream.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return reply({
          error: "Sportmonks returned an unreadable response",
          providerStatus: upstream.status
        }, 502);
      }

      if (!upstream.ok) {
        return reply({
          error: "Sportmonks request failed",
          providerStatus: upstream.status,
          details: data
        }, upstream.status);
      }

      const matches = Array.isArray(data.data) ? data.data : [];
      const result = {
        app: "JUDY AI",
        success: true,
        provider: "Sportmonks",
        date,
        timezone: "Africa/Nairobi",
        total: matches.length,
        pagination: data.pagination || null,
        fixtures: matches,
        matches
      };

      ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=" + CACHE_TTL
        }
      })));

      return reply(result);
    } catch (error) {
      return reply({
        error: "Could not connect to Sportmonks",
        details: error.message
      }, 502);
    }
  }
};
