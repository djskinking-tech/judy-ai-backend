const dateInput = document.getElementById("match-date");
const loadButton = document.getElementById("load-matches");
const messageBox = document.getElementById("message");
const fixturesBox = document.getElementById("fixtures");
const countBox = document.getElementById("match-count");
const caption = document.getElementById("results-caption");
const dateOptionButtons = Array.from(document.querySelectorAll(".date-option"));

const settingsToggle = document.getElementById("settings-toggle");
const settingsPanel = document.getElementById("settings-panel");
const settingsClose = document.getElementById("settings-close");
const defaultMatchDay = document.getElementById("default-match-day");
const autoLoadFixtures = document.getElementById("auto-load-fixtures");
const autoRefreshLive = document.getElementById("auto-refresh-live");
const compactFixtures = document.getElementById("compact-fixtures");
const settingsSaved = document.getElementById("settings-saved");
const SETTINGS_KEY = "judy-ai-preferences-v1";
const defaultSettings = { defaultMatchDay: 0, autoLoadFixtures: true, autoRefreshLiveScores: true, compactFixtures: false };
function readSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return Object.assign({}, defaultSettings, saved, {
      defaultMatchDay: Number(saved.defaultMatchDay) === 1 ? 1 : 0,
      autoLoadFixtures: saved.autoLoadFixtures !== false,
      autoRefreshLiveScores: saved.autoRefreshLiveScores !== false,
      compactFixtures: saved.compactFixtures === true
    });
  } catch (error) { return Object.assign({}, defaultSettings); }
}
let appSettings = readSettings();
function saveSettings() {
  appSettings = {
    defaultMatchDay: Number(defaultMatchDay.value) === 1 ? 1 : 0,
    autoLoadFixtures: autoLoadFixtures.checked,
    autoRefreshLiveScores: autoRefreshLive.checked,
    compactFixtures: compactFixtures.checked
  };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(appSettings)); } catch (error) {}
  document.body.classList.toggle("compact-fixtures", appSettings.compactFixtures);
  if (settingsSaved) settingsSaved.textContent = "Saved on this device.";
}
function applySettings() {
  if (!defaultMatchDay) return;
  defaultMatchDay.value = String(appSettings.defaultMatchDay);
  autoLoadFixtures.checked = appSettings.autoLoadFixtures;
  autoRefreshLive.checked = appSettings.autoRefreshLiveScores;
  compactFixtures.checked = appSettings.compactFixtures;
  document.body.classList.toggle("compact-fixtures", appSettings.compactFixtures);
}
function toggleSettings(open) {
  if (!settingsPanel || !settingsToggle) return;
  const shouldOpen = typeof open === "boolean" ? open : settingsPanel.hidden;
  settingsPanel.hidden = !shouldOpen;
  settingsToggle.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
  if (shouldOpen) settingsPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

const liveScoreList = document.getElementById("live-score-list");
const liveScoreUpdated = document.getElementById("live-score-updated");
const refreshLiveScoresButton = document.getElementById("refresh-live-scores");
let liveScoreTimer = null;

function liveTeamName(match, side) {
  const participants = Array.isArray(match.participants) ? match.participants : [];
  const team = participants.find(function (item) { return item.meta && item.meta.location === side; });
  return team && (team.name || team.short_code) || (match.name || "Match").split(" vs ")[side === "home" ? 0 : 1] || side;
}
function liveScoreFor(match) {
  const rows = Array.isArray(match.scores) ? match.scores : [];
  const current = rows.filter(function (row) {
    return ["CURRENT", "1ST_HALF", "FIRST_HALF", "HALF_TIME", "HT"].includes(String(row.description || "").toUpperCase().replace(/[\s-]+/g, "_"));
  });
  const participants = Array.isArray(match.participants) ? match.participants : [];
  const home = participants.find(function (item) { return item.meta && item.meta.location === "home"; });
  const away = participants.find(function (item) { return item.meta && item.meta.location === "away"; });
  if (!home || !away) return "—";
  function goals(team) {
    const row = current.find(function (item) { return Number(item.participant_id) === Number(team.id); });
    return row && row.score && row.score.goals != null ? Number(row.score.goals) : null;
  }
  const h = goals(home), a = goals(away);
  return h == null || a == null ? "—" : h + " - " + a;
}
function liveMinute(match) {
  const events = Array.isArray(match.events) ? match.events : [];
  const eventMinutes = events.map(function (event) { return Number(event.minute || 0); }).filter(Number.isFinite);
  const minute = match.time && (match.time.minute || match.time.extra_minute) || match.minute ||
    (eventMinutes.length ? Math.max.apply(null, eventMinutes) : null);
  return minute ? String(minute) + "'" : "";
}
function renderLiveScores(matches) {
  if (!matches.length) {
    liveScoreList.innerHTML = '<div class="live-empty">No live matches right now. JUDY AI will keep checking automatically.</div>';
    return;
  }
  liveScoreList.innerHTML = matches.map(function (match) {
    const state = match.state || {};
    const status = state.short_name || state.state || state.name || "LIVE";
    const score = liveScoreFor(match);
    const minute = liveMinute(match);
    const isFinished = ["FT","AET","FT_PEN"].includes(String(status).toUpperCase());
    return '<article class="live-score-card">' +
      '<div class="live-score-status"><span class="' + (isFinished ? "live-dot finished" : "live-dot") + '"></span>' +
      escapeHtml(String(status).toUpperCase()) + (minute && !isFinished ? ' · ' + escapeHtml(minute) : '') + '</div>' +
      '<div class="live-score-teams"><span>' + escapeHtml(liveTeamName(match,"home")) + '</span><strong>' + escapeHtml(score) + '</strong><span>' +
      escapeHtml(liveTeamName(match,"away")) + '</span></div>' +
      '<div class="live-score-league">' + escapeHtml(match.league && match.league.name || "Football") + '</div>' +
      '</article>';
  }).join("");
}
async function loadLiveScores() {
  if (!liveScoreList) return;
  try {
    const response = await fetch("/api/live-scores", { headers: {"Accept":"application/json"} });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error || "Live scores unavailable.");
    renderLiveScores(Array.isArray(payload.matches) ? payload.matches : []);
    liveScoreUpdated.textContent = "Updated " + new Intl.DateTimeFormat("en-KE", {
      timeZone: "Africa/Nairobi", hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).format(new Date(payload.updatedAt || Date.now())) + " EAT · refreshes every 30 seconds";
  } catch (error) {
    liveScoreList.innerHTML = '<div class="live-empty">' + escapeHtml(error.message || "Live scores temporarily unavailable.") + '</div>';
    liveScoreUpdated.textContent = "Live score connection unavailable";
  }
}
function nairobiToday() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const values = {};
  parts.forEach(function (part) { values[part.type] = part.value; });
  return values.year + "-" + values.month + "-" + values.day;
}
function nairobiDateOffset(days) {
  const date = new Date(nairobiToday() + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char];
  });
}
function getMatches(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.fixtures)) return payload.fixtures;
  if (Array.isArray(payload.matches)) return payload.matches;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.response)) return payload.response;
  return [];
}
function participant(match, side) {
  const participants = Array.isArray(match.participants) ? match.participants : [];
  return participants.find(function (team) {
    return team.meta && team.meta.location === side;
  }) || null;
}
function teamName(match, side) {
  const obj = side === "home"
    ? (match.homeTeam || match.home || match.teams?.home || participant(match, "home"))
    : (match.awayTeam || match.away || match.teams?.away || participant(match, "away"));
  if (typeof obj === "string") return obj;
  if (obj?.name) return obj.name;
  if (obj?.shortName) return obj.shortName;
  if (match.name && match.name.includes(" vs ")) {
    return match.name.split(" vs ")[side === "home" ? 0 : 1];
  }
  return side === "home" ? "Home team" : "Away team";
}
function teamLogo(match, side) {
  const obj = side === "home"
    ? (match.homeTeam || match.home || match.teams?.home || participant(match, "home"))
    : (match.awayTeam || match.away || match.teams?.away || participant(match, "away"));
  return obj?.logo || obj?.image || obj?.image_path || "";
}
function matchTime(match) {
  if (match.kickoffLabel) return String(match.kickoffLabel);
  const raw = match.date || match.startDate || match.kickoff || match.startTime || match.starting_at;
  if (!raw) return "Kick-off time TBC";
  const parsed = new Date(String(raw).replace(" ", "T") + (String(raw).endsWith("Z") ? "" : "Z"));
  if (Number.isNaN(parsed.getTime())) return String(raw);
  return new Intl.DateTimeFormat("en-KE", {timeZone:"Africa/Nairobi",hour:"2-digit",minute:"2-digit",hour12:true}).format(parsed) + " EAT";
}
function matchStatus(match) {
  const state = match.state || {};
  const status = match.status || {};
  return state.description || state.name || state.short_name || status.description || (typeof status === "string" ? status : "") || "Scheduled";
}
function leagueName(match) {
  const league = match.league || match.competition || {};
  return league.name || match.tournament?.name || "Football";
}
function fixtureIsFinished(match) {
  const state = match.state || {};
  const value = [state.state, state.name, state.short_name, state.developer_name, match.status].filter(Boolean).join(" ").toUpperCase();
  return /(^|\\b)(FT|AET|PEN|FULL TIME|AFTER EXTRA TIME|AFTER PENALTIES)(\\b|$)/.test(value);
}
function fixtureFinalScore(match) {
  const participants = Array.isArray(match.participants) ? match.participants : [];
  const home = participants.find(function (team) { return team.meta && team.meta.location === "home"; });
  const away = participants.find(function (team) { return team.meta && team.meta.location === "away"; });
  const rows = Array.isArray(match.scores) ? match.scores : [];
  function goals(team) {
    if (!team) return null;
    const candidates = rows.filter(function (row) {
      return Number(row.participant_id) === Number(team.id) &&
        ["CURRENT", "2ND_HALF", "FULL_TIME", "FT"].includes(String(row.description || "").toUpperCase().replace(/[\s-]+/g, "_")) &&
        row.score && row.score.goals !== null && row.score.goals !== undefined &&
        Number.isFinite(Number(row.score.goals));
    });
    if (!candidates.length) return null;
    const current = candidates.find(function (row) {
      return String(row.description || "").toUpperCase() === "CURRENT";
    });
    return Number((current || candidates[0]).score.goals);
  }
  const homeGoals = goals(home), awayGoals = goals(away);
  return homeGoals === null || awayGoals === null ? null : homeGoals + " - " + awayGoals;
}
function logoMarkup(url) {
  if (!url) return '<span class="team-placeholder">⚽</span>';
  return '<img src="' + escapeHtml(url) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">';
}
function oddsLabel(value) {
  return String(value == null ? "" : value).toLowerCase().trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}
function oddsMarketType(row) {
  const market = oddsLabel(row.market);
  if (market.includes("both teams") || market.includes("btts")) return "btts";
  if (market.includes("over") && market.includes("under")) return "goals";
  if (market.includes("match winner") || market.includes("full time result") ||
      market.includes("fulltime result") || market.includes("3 way") ||
      market === "1x2" || market === "winner") return "result";
  return "";
}
function oddsOutcome(rows, wanted) {
  return rows.find(function (row) {
    const label = oddsLabel(row.label);
    if (wanted === "home") return ["home", "1", "team 1", "1st"].includes(label);
    if (wanted === "draw") return ["draw", "x"].includes(label);
    if (wanted === "away") return ["away", "2", "team 2", "2nd"].includes(label);
    if (wanted === "over") return label === "over" && String(row.total || row.handicap || "2.5") === "2.5";
    if (wanted === "under") return label === "under" && String(row.total || row.handicap || "2.5") === "2.5";
    if (wanted === "yes") return ["yes", "both teams to score yes"].includes(label);
    if (wanted === "no") return ["no", "both teams to score no"].includes(label);
    return false;
  });
}
function renderOddsMarkup(payload) {
  const rows = Array.isArray(payload.odds) ? payload.odds : [];
  if (!rows.length) return '<p class="odds-empty">' + escapeHtml(payload.message || "No bookmaker odds are currently available for this match.") + '</p>';
  const byBookmaker = new Map();
  rows.forEach(function (row) {
    const name = row.bookmaker || "Bookmaker";
    if (!byBookmaker.has(name)) byBookmaker.set(name, []);
    byBookmaker.get(name).push(row);
  });
  const cards = Array.from(byBookmaker.entries()).slice(0, 4).map(function (entry) {
    const name = entry[0], bookmakerRows = entry[1];
    const resultRows = bookmakerRows.filter(function (row) { return oddsMarketType(row) === "result"; });
    const goalRows = bookmakerRows.filter(function (row) { return oddsMarketType(row) === "goals"; });
    const bttsRows = bookmakerRows.filter(function (row) { return oddsMarketType(row) === "btts"; });
    function price(group, key) {
      const row = oddsOutcome(group, key);
      return row ? Number(row.value).toFixed(2) : "—";
    }
    const result = resultRows.length ? '<div class="odds-market"><span>1 · X · 2</span><b>' + price(resultRows,"home") + ' · ' + price(resultRows,"draw") + ' · ' + price(resultRows,"away") + '</b></div>' : '';
    const goals = goalRows.length ? '<div class="odds-market"><span>Over / Under 2.5</span><b>' + price(goalRows,"over") + ' / ' + price(goalRows,"under") + '</b></div>' : '';
    const btts = bttsRows.length ? '<div class="odds-market"><span>BTTS Yes / No</span><b>' + price(bttsRows,"yes") + ' / ' + price(bttsRows,"no") + '</b></div>' : '';
    return '<div class="odds-bookmaker"><strong>' + escapeHtml(name) + '</strong>' +
      (result + goals + btts || '<span class="odds-empty">Requested markets not listed</span>') + '</div>';
  }).join("");
  const stamp = payload.updatedAt ? 'Last bookmaker update: ' + escapeHtml(payload.updatedAt) : 'Update time not supplied';
  return cards + '<p class="odds-updated">' + stamp + ' · Decimal odds</p>';
}
async function loadFixtureOdds(button) {
  const fixtureId = button.dataset.fixtureId;
  const panel = document.getElementById("odds-" + fixtureId);
  if (!panel || !(/^openligadb:\d+$/.test(fixtureId || "") || /^\d+$/.test(fixtureId || ""))) return;
  if (panel.dataset.loaded === "true") {
    panel.hidden = !panel.hidden;
    button.textContent = panel.hidden ? "Show odds" : "Hide odds";
    return;
  }
  button.disabled = true;
  button.textContent = "Loading odds…";
  panel.hidden = false;
  panel.innerHTML = '<p class="odds-empty">Checking available bookmakers…</p>';
  try {
    const response = await fetch("/api/odds?fixtureId=" + encodeURIComponent(fixtureId), { headers: {"Accept":"application/json"} });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error || "Odds unavailable.");
    panel.innerHTML = renderOddsMarkup(payload);
    panel.dataset.loaded = "true";
    button.textContent = "Hide odds";
  } catch (error) {
    panel.innerHTML = '<p class="odds-empty">' + escapeHtml(error.message || "Could not load odds.") + '</p>';
    button.textContent = "Retry odds";
  } finally {
    button.disabled = false;
  }
}

async function loadHeadToHead(button) {
  const fixtureId = button.dataset.fixtureId;
  const panel = document.getElementById("h2h-" + fixtureId);
  if (!panel || !/^\\d+$/.test(fixtureId || "")) return;
  if (panel.dataset.loaded === "true") {
    panel.hidden = !panel.hidden;
    button.textContent = panel.hidden ? "Head to head" : "Hide H2H";
    return;
  }
  button.disabled = true; button.textContent = "Loading H2H…";
  panel.hidden = false;
  panel.innerHTML = '<p class="odds-empty">Checking previous meetings and verified scores…</p>';
  try {
    const homeTeam = button.dataset.homeTeam || "";
    const awayTeam = button.dataset.awayTeam || "";
    const response = await fetch("/api/head-to-head?fixtureId=" + encodeURIComponent(fixtureId) + "&homeTeam=" + encodeURIComponent(homeTeam) + "&awayTeam=" + encodeURIComponent(awayTeam), { headers: {"Accept":"application/json"} });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error || "Head-to-head history unavailable.");
    const s = payload.summary || {}, r = payload.rates || {};
    const home = payload.fixture && payload.fixture.homeTeam || "Home", away = payload.fixture && payload.fixture.awayTeam || "Away";
    const meetings = Array.isArray(payload.meetings) ? payload.meetings : [];
    const summaryHtml = s.played
      ? '<div class="h2h-summary"><div><b>' + escapeHtml(s.homeTeamWins) + '</b><span>' + escapeHtml(home) + ' wins</span></div><div><b>' + escapeHtml(s.draws) + '</b><span>Draws</span></div><div><b>' + escapeHtml(s.awayTeamWins) + '</b><span>' + escapeHtml(away) + ' wins</span></div></div><div class="h2h-stats"><span>Goals: ' + escapeHtml(s.homeTeamGoals) + ' - ' + escapeHtml(s.awayTeamGoals) + '</span><span>Avg goals: ' + escapeHtml(r.averageGoals) + '</span><span>BTTS: ' + escapeHtml(r.bothTeamsScored) + '%</span><span>Over 2.5: ' + escapeHtml(r.over25) + '%</span></div>'
      : '<p class="odds-empty">No completed head-to-head meetings with verified scores were returned by the provider.</p>';
    const historyHtml = meetings.length ? '<div class="h2h-meetings">' + meetings.map(function (m) {
      const date = m.date ? new Date(m.date.replace(" ", "T") + (m.date.includes("Z") ? "" : "Z")).toLocaleDateString() : "Date unavailable";
      return '<div class="h2h-meeting"><span>' + escapeHtml(date) + '</span><b>' + escapeHtml(m.homeTeam) + ' ' + escapeHtml(m.homeGoals) + ' - ' + escapeHtml(m.awayGoals) + ' ' + escapeHtml(m.awayTeam) + '</b><small>' + escapeHtml(m.competition || "Competition unavailable") + '</small></div>';
    }).join("") + '</div>' : "";
    panel.innerHTML = '<strong>HEAD-TO-HEAD · LAST ' + escapeHtml(s.played || 0) + ' VERIFIED MEETINGS</strong>' + summaryHtml + historyHtml + '<small>' + escapeHtml(payload.note || "Historical context only; not a prediction guarantee.") + '</small>';
    panel.dataset.loaded = "true"; button.textContent = "Hide H2H";
  } catch (error) {
    panel.innerHTML = '<p class="odds-empty">' + escapeHtml(error.message || "Could not load head-to-head history.") + '</p>';
    button.textContent = "Retry H2H";
  } finally { button.disabled = false; }
}

function renderMatches(matches) {
  if (!matches.length) {
    fixturesBox.innerHTML = '<div class="empty-state">No fixtures were returned for this date. Try another date.</div>';
    countBox.textContent = "0 MATCHES";
    return;
  }
  countBox.textContent = matches.length + (matches.length === 1 ? " MATCH" : " MATCHES");
  fixturesBox.innerHTML = matches.map(function (match) {
    const home = teamName(match, "home");
    const away = teamName(match, "away");
    const league = leagueName(match);
    const status = matchStatus(match);
    const fixtureId = match.id || match.fixture_id || "";
    const isOpenLiga = match.fixtureSource === "OpenLigaDB";
    const supportsPredictions = isOpenLiga || (match.fixtureSource !== "TheSportsDB" && match.predictionsSupported !== false);
    const supportsOdds = !isOpenLiga && supportsPredictions && /^\d+$/.test(String(fixtureId));
    const supportsHeadToHead = supportsPredictions && (isOpenLiga || /^\d+$/.test(String(fixtureId)));
    const actions = supportsPredictions
      ? '<div class="prediction-actions"><button class="prediction-button" data-finished="' + (fixtureIsFinished(match) ? "true" : "false") + '" data-fixture-id="' + escapeHtml(fixtureId) + '">' + (fixtureIsFinished(match) ? "Match finished" : "Generate AI predictions") + '</button>' + (supportsOdds ? '<button class="odds-button" type="button" data-fixture-id="' + escapeHtml(fixtureId) + '">Show odds</button>' : '') + (supportsHeadToHead ? '<button class="h2h-button" type="button" data-fixture-id="' + escapeHtml(fixtureId) + '" data-home-team="' + escapeHtml(home) + '" data-away-team="' + escapeHtml(away) + '">Head to head</button>' : '') + '</div>' +
        (supportsOdds ? '<div class="odds-panel" id="odds-' + escapeHtml(fixtureId) + '" hidden></div>' : '') + (supportsHeadToHead ? '<div class="h2h-panel" id="h2h-' + escapeHtml(fixtureId) + '" hidden></div>' : '') +
        '<div class="prediction-results" id="prediction-' + escapeHtml(fixtureId) + '"><div class="prediction-label"><span>Half-time score</span><b>Checking saved prediction…</b></div><div class="prediction-label"><span>Full-time score</span><b>Checking saved prediction…</b></div></div>'
      : '<div class="prediction-label"><span>Prediction status</span><b>Not available for this fallback fixture source yet. No score prediction or bookmaker odds will be invented.</b></div>';
    return '<article class="fixture-card">' +
      '<div class="fixture-meta"><span class="fixture-league">' + escapeHtml(league) + '</span><span>' + escapeHtml(status) + '</span>' +
      (match.fixtureSource ? '<span>' + escapeHtml(match.fixtureSource) + '</span>' : '') + '</div>' +
      '<div class="fixture-teams">' +
        '<div class="team">' + logoMarkup(teamLogo(match,"home")) + '<div class="team-name">' + escapeHtml(home) + '</div></div>' +
        '<div class="versus fixture-score">' + escapeHtml(fixtureFinalScore(match) || "VS") + '</div>' +
        '<div class="team">' + logoMarkup(teamLogo(match,"away")) + '<div class="team-name">' + escapeHtml(away) + '</div></div>' +
      '</div>' +
      '<div class="fixture-foot"><span>' + escapeHtml(matchTime(match)) + '</span><span>' + escapeHtml(match.country?.name || match.country || "Worldwide") + '</span></div>' +
      (match.dataNote ? '<p class="fixture-data-note">' + escapeHtml(match.dataNote) + '</p>' : '') +
      actions +
      '</article>';
  }).join("");
  loadSavedPredictions(matches);
}
async function loadSavedPredictions(matches) {
  const ids = matches.filter(function (match) { return match.fixtureSource === "OpenLigaDB" || (match.fixtureSource !== "TheSportsDB" && match.predictionsSupported !== false); }).map(function (match) { return String(match.id || match.fixture_id || ""); }).filter(function (id) { return /^\d+$/.test(id) || /^openligadb:\d+$/.test(id); });
  if (!ids.length) return;
  try {
    const response = await fetch("/api/predictions/saved?fixtureIds=" + encodeURIComponent(ids.join(",")), { headers: {"Accept":"application/json"} });
    const payload = await response.json();
    if (!response.ok || !payload.success || !payload.predictions) throw new Error(payload.error || "Saved predictions unavailable");
    ids.forEach(function (id) {
      const saved = payload.predictions[id];
      const panel = document.getElementById("prediction-" + id);
      const button = document.querySelector(".prediction-button[data-fixture-id=\"" + id + "\"]");
      if (!panel || !button) return;
      if (!saved) {
        if (button.dataset.finished === "true") {
          panel.innerHTML = '<div class="prediction-label"><span>Prediction status</span><b>No pre-match prediction was saved. The actual score is shown above; prediction accuracy cannot be calculated.</b></div>';
          button.textContent = "Match finished";
          button.disabled = true;
        } else {
          panel.innerHTML = '<div class="prediction-label"><span>Prediction status</span><b>Automatic preparation pending</b></div>';
          button.textContent = "Generate now";
        }
        return;
      }
      panel.innerHTML = predictionOptionsMarkup("Half-time", saved.predictions && saved.predictions.halfTime) +
        predictionOptionsMarkup("Full-time", saved.predictions && saved.predictions.fullTime) +
        '<p class="prediction-disclaimer">Saved automatically before kick-off · '+ escapeHtml(saved.confidence || "Confidence not rated") + ' confidence. Not guaranteed.</p>' +
        dataQualityMarkup(saved.dataQuality) + teamIntelligenceMarkup(saved.teamIntelligence) + playerWatchMarkup(saved.playerWatch) + predictionOutcomeMarkup(saved) +
        '<p class="prediction-tracking tracking-confirmed">Original prediction saved before kick-off.</p>';
      button.textContent = "Prediction saved";
      button.disabled = true;
    });
  } catch (error) {
    console.warn("Could not load saved predictions:", error);
    document.querySelectorAll(".prediction-results").forEach(function (panel) {
      if (panel.textContent.includes("Checking saved prediction")) panel.innerHTML = '<div class="prediction-label"><span>Prediction status</span><b>Could not check saved predictions. Refresh fixtures.</b></div>';
    });
  }
}
function predictionOptionsMarkup(period, data) {
  if (!data || !Array.isArray(data.options) || !data.options.length) {
    return '<div class="prediction-label"><span>' + period + '</span><b>Insufficient data</b></div>';
  }
  return '<div class="prediction-label"><span>' + period + '</span><b>' +
    data.options.map(function (option) {
      return escapeHtml(option.score) + ' · ' + escapeHtml(option.probability) + '%';
    }).join('  |  ') + '</b></div>';
}
function predictionOutcomeMarkup(payload) {
  const tracking = payload && payload.tracking ? payload.tracking : {};
  const actual = tracking.actual || {};
  const evaluation = tracking.evaluation && tracking.evaluation.v2_1 ? tracking.evaluation.v2_1 : {};
  function period(label, key, actualScore) {
    let hit = evaluation[key] && evaluation[key].topTwo;
    // Fall back to the saved two ranked scores if an older tracking record
    // has an actual score but does not yet contain its evaluation.
    if (typeof hit !== "boolean" && actualScore) {
      const options = payload && payload.predictions && payload.predictions[key] &&
        Array.isArray(payload.predictions[key].options) ? payload.predictions[key].options : [];
      if (options.length) {
        hit = options.some(function (option) {
          return String(option.score || "").trim() === String(actualScore).trim();
        });
      }
    }
    const status = hit === true ? "WON" : hit === false ? "LOST" : "PENDING";
    const statusClass = hit === true ? "outcome-won" : hit === false ? "outcome-lost" : "outcome-pending";
    const scoreText = actualScore ? "Actual: " + escapeHtml(actualScore) : "Actual score: pending";
    return '<div class="outcome-period"><b class="' + statusClass + '">' + label + ': ' + status +
      '</b><span>' + scoreText + '</span></div>';
  }
  const complete = tracking.recordStatus === "completed";
  return '<section class="prediction-outcome ' + (complete ? "completed" : "pending") + '">' +
    '<strong>JUDY AI RESULT TRACKING</strong>' +
    period("HALF-TIME", "halfTime", actual.halfTime) +
    period("FULL-TIME", "fullTime", actual.fullTime) +
    '<small>WON means at least one of JUDY AI’s two ranked scores matched. LOST means neither matched. Results remain PENDING until the official score is available.</small></section>';
}
function playerWatchMarkup(data) {
  if (!data) return '<section class="player-watch"><h4>PLAYER WATCH</h4><p>Player availability: Unknown — provider data not available.</p></section>';
  const absences = Array.isArray(data.absences) ? data.absences : [];
  function list(rows) {
    return rows.length ? rows.map(row => '<li>' + escapeHtml(row.name) + ' — ' + escapeHtml(row.position) + '</li>').join('') : '<li>Not available yet</li>';
  }
  const absenceHtml = absences.length
    ? absences.map(row => '<li><strong>' + escapeHtml(row.category || "Unavailable") + ':</strong> ' +
      escapeHtml(row.player) + ' · ' + escapeHtml(row.team || "Team not identified") +
      ' — ' + escapeHtml(row.reason || "Reason not supplied") +
      (row.endDate ? ' · Until ' + escapeHtml(String(row.endDate).slice(0,10)) : '') + '</li>').join('')
    : '<li>No unavailable players supplied by the data source for this fixture. This does not confirm that every player is fit.</li>';
  const impact = data.predictionImpact || {};
  return '<section class="player-watch"><h4>PLAYER WATCH · INJURIES & MISSING PLAYERS</h4><strong>Unavailable / doubtful players</strong><ul>' + absenceHtml +
    '</ul><strong>' + escapeHtml(data.lineups && data.lineups.label || "Confirmed / expected lineups") +
    '</strong><div class="player-watch-teams"><div><b>Home team</b><ul>' + list(data.lineups && data.lineups.home || []) +
    '</ul></div><div><b>Away team</b><ul>' + list(data.lineups && data.lineups.away || []) +
    '</ul></div></div><div class="player-impact"><strong>Effect on score predictions: ' +
    escapeHtml(impact.status || "Not assessed") + '</strong><p>' +
    escapeHtml(impact.reason || "Player impact has not been verified.") +
    '</p></div><small>Source: ' + escapeHtml(data.source || "Not supplied") +
    '. Only provider-listed information is shown. Missing information is not guessed.</small></section>';
}
function dataQualityMarkup(data) {
  if (!data) return '<section class="data-quality"><h4>DATA QUALITY</h4><p>Quality report unavailable for this saved prediction.</p></section>';
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  const recent = data.recentMatchesUsed || {};
  const venue = data.venueSpecificMatches || {};
  const firstHalf = data.firstHalfMatchesAvailable || {};
  const warningHtml = warnings.length
    ? '<ul>' + warnings.map(item => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>'
    : '<p>No major data limitations were flagged by the model.</p>';
  return '<section class="data-quality"><h4>DATA QUALITY · ' + escapeHtml(data.confidenceLevel || 'Unrated') + ' CONFIDENCE</h4>' +
    '<div class="quality-stats"><span>Recent matches: ' + escapeHtml(recent.home ?? '—') + ' home / ' + escapeHtml(recent.away ?? '—') + ' away</span>' +
    '<span>First-half samples: ' + escapeHtml(firstHalf.home ?? '—') + ' home / ' + escapeHtml(firstHalf.away ?? '—') + ' away</span>' +
    '<span>Home/away venue samples: ' + escapeHtml(venue.homeTeamAtHome ?? '—') + ' / ' + escapeHtml(venue.awayTeamAway ?? '—') + '</span></div>' +
    '<strong>Data limitations</strong>' + warningHtml +
    '<small>These checks describe data coverage, not the chance of winning.</small></section>';
}
function teamIntelligenceMarkup(data) {
  if (!data || !data.home || !data.away) return "";
  function teamBlock(label, team) {
    const form = (team.lastFive || []).map(item => item.outcome).join(" · ") || "Unknown";
    const venueLabel = team.venueSplit === "home" ? "Home" :
      team.venueSplit === "away" ? "Away" : "All venues";
    return '<div class="intelligence-team"><strong>' + label + '</strong>' +
      '<span>Recent form: ' + escapeHtml(form) + '</span>' +
      '<span>W-D-L: ' + escapeHtml(team.wins == null || team.draws == null || team.losses == null ? "Not available" : team.wins + "-" + team.draws + "-" + team.losses) +
      ' · ' + escapeHtml(venueLabel) + ' sample: ' + escapeHtml(team.venueMatches == null ? "Not available" : team.venueMatches) + '</span>' +
      '<span>Avg goals: ' + escapeHtml(team.averageGoalsFor == null ? "Not available" : team.averageGoalsFor) + ' scored / ' +
      escapeHtml(team.averageGoalsAgainst == null ? "Not available" : team.averageGoalsAgainst) + ' conceded</span></div>';
  }
  return '<section class="team-intelligence"><h4>TEAM INTELLIGENCE · RECENT FORM</h4>' +
    teamBlock("Home team", data.home) + teamBlock("Away team", data.away) +
    '<small>Based on completed match results. Injuries, suspensions and lineups are not verified here.</small></section>';
}
async function generatePrediction(button) {
  const fixtureId = button.dataset.fixtureId;
  const panel = document.getElementById("prediction-" + fixtureId);
  if (!fixtureId || !panel) {
    button.textContent = "Prediction unavailable";
    button.disabled = true;
    return;
  }
  button.disabled = true;
  button.textContent = "Analysing recent form…";
  panel.innerHTML = '<div class="prediction-loading">JUDY AI is analysing recent team results…</div>';
  try {
    const response = await fetch("/api/predictions?fixtureId=" + encodeURIComponent(fixtureId), {
      headers: {"Accept":"application/json"}
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error || "Prediction request failed.");
    if (!payload.success) {
      if (payload.status === "insufficient_history") {
        const homeCount = Number(payload.sampleSize && payload.sampleSize.home || 0);
        const awayCount = Number(payload.sampleSize && payload.sampleSize.away || 0);
        const minimum = Number(payload.minimumRequired || 3);
        panel.innerHTML = '<div class="prediction-error">' +
          escapeHtml(payload.message || "Not enough recent match data to make a responsible prediction.") +
          '<br>Home team: ' + escapeHtml(homeCount) + '/' + escapeHtml(minimum) +
          ' matches · Away team: ' + escapeHtml(awayCount) + '/' + escapeHtml(minimum) +
          ' matches required.</div>';
        button.textContent = "Try again";
        return;
      }
      throw new Error(payload.message || "Not enough historical data for a prediction.");
    }
    const saveStatus = payload.tracking && payload.tracking.saveStatus
      ? payload.tracking.saveStatus : "save_status_missing";
    const trackingMessage = payload.historical
      ? "✓ Original pre-kickoff prediction · saved and shown after kick-off"
      : saveStatus === "saved"
        ? "✓ Prediction saved before kick-off"
        : saveStatus === "already_saved"
          ? "✓ Original pre-kickoff prediction is already saved"
          : saveStatus === "storage_not_configured"
            ? "⚠ Prediction storage is not configured; this prediction was not saved"
            : saveStatus === "save_failed"
              ? "⚠ Prediction could not be saved. Please try again and check tracking."
              : "⚠ Save confirmation was not received";
    const trackingClass = (saveStatus === "saved" || saveStatus === "already_saved")
      ? "tracking-confirmed" : "tracking-warning";
    panel.innerHTML = predictionOptionsMarkup("Half-time", payload.predictions.halfTime) +
      predictionOptionsMarkup("Full-time", payload.predictions.fullTime) +
      '<p class="prediction-disclaimer">' + (payload.historical ? 'Original pre-kickoff estimate · ' : 'Experimental estimates · ') +
      escapeHtml(payload.confidence || "Unrated") + ' confidence · ' +
      escapeHtml(payload.sampleSize && payload.sampleSize.home != null ? payload.sampleSize.home : "—") +
      ' home / ' + escapeHtml(payload.sampleSize && payload.sampleSize.away != null ? payload.sampleSize.away : "—") +
      ' away matches analysed. Not guaranteed.</p>' +
      dataQualityMarkup(payload.dataQuality) +
      teamIntelligenceMarkup(payload.teamIntelligence) +
      playerWatchMarkup(payload.playerWatch) +
      predictionOutcomeMarkup(payload) +
      '<p class="prediction-tracking ' + trackingClass + '">' + escapeHtml(trackingMessage) + '</p>';
    button.textContent = payload.historical ? "View saved prediction" : "Refresh predictions";
  } catch (error) {
    panel.innerHTML = '<div class="prediction-error">' + escapeHtml(error.message || "Could not generate predictions.") + '</div>';
    button.textContent = "Try again";
  } finally {
    button.disabled = false;
  }
}
function showMessage(title, detail, type) {
  messageBox.className = "message" + (type ? " " + type : "");
  messageBox.innerHTML = '<span class="message-icon">✦</span><div><strong>' + escapeHtml(title) + '</strong><p>' + escapeHtml(detail) + '</p></div>';
}
async function loadFixtures() {
  const date = dateInput.value;
  if (!date) {
    showMessage("Choose a match date", "Please select a date before loading fixtures.", "error");
    return;
  }
  loadButton.disabled = true;
  loadButton.textContent = "Loading…";
  fixturesBox.innerHTML = '<div class="empty-state">Connecting to JUDY AI data center…</div>';
  countBox.textContent = "LOADING";
  caption.textContent = "Fetching fixtures for " + date + ".";
  showMessage("Checking worldwide fixtures", "JUDY AI is requesting the selected date from Sportmonks.", "");
  try {
    const response = await fetch("/api/matches?date=" + encodeURIComponent(date), {
      method: "GET",
      headers: {"Accept":"application/json"}
    });
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error("The data provider returned an unreadable response."); }

    if (response.status === 429 || payload.providerStatus === 429) {
      fixturesBox.innerHTML = "";
      countBox.textContent = "UNAVAILABLE";
      caption.textContent = "Fixture data is temporarily unavailable.";
      showMessage("Sportmonks request limit reached", "The Sportmonks account has reached its current request allowance. Please check the provider dashboard or try again later.", "error");
      return;
    }
    if (!response.ok || payload.success === false || payload.error) {
      const detail = payload.details && payload.details.message ? ": " + payload.details.message : "";
      throw new Error((payload.error || "Unable to load fixtures. Please try again later.") + detail);
    }
    const matches = getMatches(payload);
    renderMatches(matches);
    caption.textContent = "Fixtures for " + date + " · East Africa Time";
    const sourceNote = document.getElementById("fixture-source-note");
    if (sourceNote) {
      sourceNote.hidden = !payload.fallbackNote;
      sourceNote.textContent = payload.fallbackNote || "";
      sourceNote.classList.toggle("source-note-warning", Boolean(payload.fallbackNote));
    }
    if (matches.length) {
      const providerName = payload.provider || "Sportmonks";
      showMessage("Fixtures loaded", "Received " + matches.length + " matches from " + providerName + "." + (payload.fallbackNote ? " " + payload.fallbackNote : ""), "success");
    } else {
      showMessage("No fixtures in the returned data", "Sportmonks returned zero matches for this date. It may be outside the leagues included in the current subscription. Try another date or an included league. JUDY AI will not invent fixtures.", "error");
    }
  } catch (error) {
    fixturesBox.innerHTML = "";
    countBox.textContent = "— MATCHES";
    showMessage("We couldn't load fixtures", error.message || "Please check your connection and try again.", "error");
  } finally {
    loadButton.disabled = false;
    loadButton.innerHTML = 'Load fixtures <span>→</span>';
  }
}
applySettings();
dateInput.value = nairobiDateOffset(appSettings.defaultMatchDay);
dateOptionButtons.forEach(function (button) {
  const selected = Number(button.dataset.dateOffset) === appSettings.defaultMatchDay;
  button.classList.toggle("active", selected);
  button.setAttribute("aria-pressed", selected ? "true" : "false");
});
document.getElementById("year").textContent = new Date().getFullYear();
loadButton.addEventListener("click", loadFixtures);
function setQuickDate(offset) {
  dateInput.value = nairobiDateOffset(offset);
  dateOptionButtons.forEach(function (button) {
    const selected = Number(button.dataset.dateOffset) === offset;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
  loadFixtures();
}
dateOptionButtons.forEach(function (button) {
  button.addEventListener("click", function () {
    setQuickDate(Number(button.dataset.dateOffset));
  });
});
dateInput.addEventListener("change", function () {
  const selectedOffset = [-1, 0, 1].find(function (offset) {
    return nairobiDateOffset(offset) === dateInput.value;
  });
  dateOptionButtons.forEach(function (button) {
    const selected = Number(button.dataset.dateOffset) === selectedOffset;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
});
if (refreshLiveScoresButton) refreshLiveScoresButton.addEventListener("click", loadLiveScores);
loadLiveScores();
liveScoreTimer = setInterval(function () {
  if (appSettings.autoRefreshLiveScores && !document.hidden) loadLiveScores();
}, 30000);
if (settingsToggle) settingsToggle.addEventListener("click", function () { toggleSettings(); });
if (settingsClose) settingsClose.addEventListener("click", function () { toggleSettings(false); });
[defaultMatchDay, autoLoadFixtures, autoRefreshLive, compactFixtures].forEach(function (control) {
  if (control) control.addEventListener("change", function () {
    saveSettings();
    if (control === defaultMatchDay) {
      dateInput.value = nairobiDateOffset(appSettings.defaultMatchDay);
      dateOptionButtons.forEach(function (button) {
        const selected = Number(button.dataset.dateOffset) === appSettings.defaultMatchDay;
        button.classList.toggle("active", selected);
        button.setAttribute("aria-pressed", selected ? "true" : "false");
      });
      if (appSettings.autoLoadFixtures) loadFixtures();
    } else if (control === autoLoadFixtures && appSettings.autoLoadFixtures) {
      loadFixtures();
    } else if (control === autoRefreshLive && appSettings.autoRefreshLiveScores) {
      loadLiveScores();
    }
  });
});
if (appSettings.autoLoadFixtures) loadFixtures();

fixturesBox.addEventListener("click", function (event) {
  const h2hButton = event.target.closest(".h2h-button");
  if (h2hButton) { loadHeadToHead(h2hButton); return; }
  const oddsButton = event.target.closest(".odds-button");
  if (oddsButton) {
    loadFixtureOdds(oddsButton);
    return;
  }
  const button = event.target.closest(".prediction-button");
  if (button) generatePrediction(button);
});
