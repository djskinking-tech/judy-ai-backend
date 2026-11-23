const WEBSITE_ORIGIN = "https://judy-ai-backend-live.djskinking.workers.dev";
const CACHE_TTL = 900;


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

export default {
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

    if (url.pathname === "/api/diagnostics") {
      return reply({
        app: "JUDY AI",
        sportmonksTokenConfigured: Boolean(env.SPORTMONKS_API_TOKEN),
        availableBindingNames: Object.keys(env)
      });
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
        const apiUrl = new URL("https://api.sportmonks.com/v3/football/" + path);
        apiUrl.searchParams.set("api_token", env.SPORTMONKS_API_TOKEN);
        for (const [key, value] of Object.entries(params)) apiUrl.searchParams.set(key, value);
        const response = await fetch(apiUrl.toString(), { headers: { "Accept": "application/json" } });
        const raw = await response.text();
        let body;
        try { body = JSON.parse(raw); } catch { throw new Error("Sportmonks returned unreadable data (HTTP " + response.status + ")."); }
        if (!response.ok) {
          const error = new Error("Sportmonks request failed (HTTP " + response.status + ").");
          error.status = response.status;
          error.details = body;
          throw error;
        }
        return body.data;
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
          const [homeHistory, awayHistory] = await Promise.all([
            sportmonks("fixtures/between/" + startDate + "/" + endDate + "/" + homeTeam.id, {
              include: "scores;participants;league", per_page: "50", order: "desc"
            }),
            sportmonks("fixtures/between/" + startDate + "/" + endDate + "/" + awayTeam.id, {
              include: "scores;participants;league", per_page: "50", order: "desc"
            })
          ]);

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
      const cacheKey = new Request("https://judy-ai-cache.example/sportmonks/predictions/v3/" + fixtureId);
      const cached = await cache.match(cacheKey);
      if (cached) return new Response(cached.body, {
        status: cached.status,
        headers: { ...Object.fromEntries(cached.headers), "Access-Control-Allow-Origin": WEBSITE_ORIGIN }
      });

      async function sportmonks(path, params = {}) {
        const apiUrl = new URL("https://api.sportmonks.com/v3/football/" + path);
        apiUrl.searchParams.set("api_token", env.SPORTMONKS_API_TOKEN);
        for (const [key, value] of Object.entries(params)) apiUrl.searchParams.set(key, value);
        const response = await fetch(apiUrl.toString(), { headers: { "Accept": "application/json" } });
        const raw = await response.text();
        let body;
        try { body = JSON.parse(raw); } catch { throw new Error("Sportmonks returned unreadable data (HTTP " + response.status + ")."); }
        if (!response.ok) {
          const error = new Error("Sportmonks request failed (HTTP " + response.status + ").");
          error.status = response.status;
          error.details = body;
          throw error;
        }
        return body.data;
      }

      try {
        const target = await sportmonks("fixtures/" + fixtureId, { include: "participants;league" });
        if (!target || !Array.isArray(target.participants)) {
          return reply({ error: "Fixture or participant data was not found." }, 404);
        }
        const homeTeam = target.participants.find(p => p.meta && p.meta.location === "home");
        const awayTeam = target.participants.find(p => p.meta && p.meta.location === "away");
        if (!homeTeam || !awayTeam) return reply({ error: "Could not identify both teams for this fixture." }, 422);

        const kickoff = new Date(String(target.starting_at).replace(" ", "T") + "Z");
        if (Number.isNaN(kickoff.getTime())) return reply({ error: "Fixture kick-off date is invalid." }, 422);
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
