(function () {
  const root = document.getElementById("performance-dashboard");
  if (!root) return;

  const refreshButton = document.getElementById("refresh-performance");
  const status = document.getElementById("performance-status");
  const totals = document.getElementById("performance-totals");
  const modelGrid = document.getElementById("model-performance");
  const records = document.getElementById("prediction-records");

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char];
    });
  }
  function metricLabel(metric) {
    if (!metric || !metric.total) return "Awaiting results";
    return metric.hits + "/" + metric.total + " · " + metric.accuracyPercent + "%";
  }
  function metricCard(title, metric) {
    return '<div class="metric-card"><span>' + escapeHtml(title) + '</span><strong>' +
      escapeHtml(metricLabel(metric)) + '</strong></div>';
  }
  function renderModel(name, data) {
    return '<article class="model-card"><div class="model-title"><h3>' + escapeHtml(name) +
      '</h3><span>TRACKED RESULTS</span></div><div class="metric-grid">' +
      metricCard("FT exact score", data.fullTimeExact) +
      metricCard("FT top two", data.fullTimeTopTwo) +
      metricCard("HT exact score", data.halfTimeExact) +
      metricCard("HT top two", data.halfTimeTopTwo) +
      '</div></article>';
  }

  function accuracyStats(rows, model) {
    const fields=[["HT exact","halfTime","exact"],["HT top two","halfTime","topTwo"],["FT exact","fullTime","exact"],["FT top two","fullTime","topTwo"]];
    return fields.map(function(field){
      const values=rows.map(function(row){const group=row.evaluation&&row.evaluation[model]&&row.evaluation[model][field[1]];return group&&typeof group[field[2]]==="boolean"?group[field[2]]:null;}).filter(function(value){return value!==null;});
      const hits=values.filter(Boolean).length;
      return {label:field[0],hits:hits,total:values.length,pct:values.length?(hits/values.length*100).toFixed(1):"—"};
    });
  }
  function accuracyCards(rows,model){
    return '<div class="accuracy-stats">'+accuracyStats(rows,model).map(function(stat){
      return '<div class="accuracy-stat"><span>'+escapeHtml(stat.label)+'</span><strong>'+(stat.total?stat.hits+'/'+stat.total+' · '+stat.pct+'%':'Awaiting data')+'</strong></div>';
    }).join("")+'</div>';
  }
  function renderAccuracyCentre(items){
    const completed=items.filter(function(item){return item.status==="completed";});
    const overview=document.getElementById("accuracy-overview"), leagueNode=document.getElementById("accuracy-leagues"), monthNode=document.getElementById("accuracy-months");
    if(!overview||!leagueNode||!monthNode)return;
    overview.innerHTML='<div class="accuracy-total"><span>Evaluated matches</span><strong>'+completed.length+'</strong></div>'+
      '<div class="accuracy-models"><article><h4>V1 baseline</h4>'+accuracyCards(completed,"v1")+'</article><article><h4>Current saved model</h4>'+accuracyCards(completed,"v2_1")+'</article></div>';
    function groupsBy(keyFn){
      const groups=new Map();completed.forEach(function(item){const key=keyFn(item);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);});
      return Array.from(groups.entries()).sort(function(a,b){return b[0].localeCompare(a[0]);});
    }
    function draw(node,groups){
      if(!groups.length){node.innerHTML='<p class="accuracy-empty">No completed matches recorded yet.</p>';return;}
      node.innerHTML=groups.map(function(entry){return '<article class="accuracy-group"><div class="accuracy-group-head"><strong>'+escapeHtml(entry[0])+'</strong><span>'+entry[1].length+' completed</span></div><b>V1 baseline</b>'+accuracyCards(entry[1],"v1")+'<b>Current saved model</b>'+accuracyCards(entry[1],"v2_1")+'</article>';}).join("");
    }
    draw(leagueNode,groupsBy(function(item){return item.fixture&&item.fixture.league||"League not recorded";}));
    draw(monthNode,groupsBy(function(item){
      const date=item.completedAt||(item.fixture&&item.fixture.startingAt)||item.capturedAt, parsed=new Date(String(date||"").replace(" ","T"));
      return Number.isNaN(parsed.getTime())?"Date not recorded":new Intl.DateTimeFormat("en-CA",{timeZone:"Africa/Nairobi",year:"numeric",month:"long"}).format(parsed);
    }));
  }

  function hitLabel(label, hit) {
    if (hit === true) return label + ': WON';
    if (hit === false) return label + ': LOST';
    return label + ': PENDING';
  }
  let allRecords = [];
  function renderRecords(items) {
    allRecords = Array.isArray(items) ? items : [];
    const query = (document.getElementById("performance-search")?.value || "").trim().toLowerCase();
    const filtered = allRecords.filter(function (item) {
      const fixture = item.fixture || {};
      const text = [fixture.name, fixture.homeTeam, fixture.awayTeam, fixture.league, item.fixtureId]
        .filter(Boolean).join(" ").toLowerCase();
      return !query || text.includes(query);
    });
    if (!filtered.length) {
      records.innerHTML = '<div class="dashboard-empty">' +
        (allRecords.length ? 'No prediction records match that search.' : 'No predictions have been saved yet. Generate a prediction for an upcoming match to start tracking.') +
        '</div>';
      return;
    }
    records.innerHTML = filtered.map(function (item) {
      const fixture = item.fixture || {};
      const name = fixture.name || ((fixture.homeTeam || "Home") + " vs " + (fixture.awayTeam || "Away"));
      const actual = item.actual || {};
      const evaluation = item.evaluation || {};
      const predictions = item.predictions || {};
      const baseline = item.baselineV1 || {};
      function scoreText(source, period) {
        const options = source && source[period] && Array.isArray(source[period].options) ? source[period].options : [];
        return options.length ? options.map(function (option) {
          return String(option.score || "—") + (option.probability != null ? " (" + option.probability + "%)" : "");
        }).join(" · ") : "Not available";
      }
      function hitText(model, period) {
        const result = evaluation[model] && evaluation[model][period];
        if (!result || result.topTwo == null) return "Awaiting result";
        return result.topTwo ? "TOP TWO HIT" : "MISSED TOP TWO";
      }
      function modelPanel(label, modelKey, source) {
        const isHit = function (period) {
          const result = evaluation[modelKey] && evaluation[modelKey][period];
          return result && result.topTwo === true ? "hit" : result && result.topTwo === false ? "miss" : "waiting";
        };
        return '<div class="record-model"><strong>' + escapeHtml(label) + '</strong>' +
          '<div><span>HT prediction</span><b>' + escapeHtml(scoreText(source, "halfTime")) + '</b><small class="' + isHit("halfTime") + '">' + escapeHtml(hitText(modelKey, "halfTime")) + '</small></div>' +
          '<div><span>FT prediction</span><b>' + escapeHtml(scoreText(source, "fullTime")) + '</b><small class="' + isHit("fullTime") + '">' + escapeHtml(hitText(modelKey, "fullTime")) + '</small></div></div>';
      }
      const isCompleted = item.status === "completed";
      return '<article class="record-row record-comparison"><div class="record-match-head"><div><strong>' + escapeHtml(name) +
        '</strong><span>' + escapeHtml(fixture.league || "League TBC") + ' · ' + escapeHtml(fixture.startingAt || "Kick-off TBC") +
        '</span></div><span class="record-status ' + (isCompleted ? "is-complete" : "") + '">' + (isCompleted ? "RESULT RECORDED" : "PENDING") + '</span></div>' +
        '<div class="record-model-grid">' + modelPanel("V1 baseline", "v1", baseline) +
        modelPanel(item.experimental ? "Experimental model · V2.2" : "V2.1 model", "v2_1", predictions) + '</div>' +
        '<div class="record-actual"><span>ACTUAL RESULT</span><strong>HT ' + escapeHtml(actual.halfTime || "—") +
        ' · FT ' + escapeHtml(actual.fullTime || "—") + '</strong></div></article>';
    }).join("");
  }
  async function loadPerformance() {
    refreshButton.disabled = true;
    refreshButton.textContent = "Refreshing…";
    status.textContent = "Loading saved predictions and measured results…";
    try {
      const response = await fetch("/api/tracking", {headers: {"Accept":"application/json"}});
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || "Could not load performance data.");
      const pending = Number(payload.pendingPredictions || 0);
      const completed = Number(payload.completedPredictions || 0);
      totals.innerHTML = '<div class="total-card"><span>Total saved</span><strong>' +
        Number(payload.totalPredictions || 0) + '</strong></div><div class="total-card"><span>Awaiting results</span><strong>' +
        pending + '</strong></div><div class="total-card"><span>Completed</span><strong>' + completed + '</strong></div>';
      const metrics = payload.metrics || {};
      modelGrid.innerHTML = renderModel("V1 baseline", metrics.v1 || {}) +
        renderModel("V2.1 experimental", metrics.v2_1 || {});
      renderRecords(Array.isArray(payload.records) ? payload.records : []);
      renderAccuracyCentre(Array.isArray(payload.records) ? payload.records : []);
      status.textContent = "Updated " + new Intl.DateTimeFormat("en-KE", {
        timeZone:"Africa/Nairobi", hour:"2-digit", minute:"2-digit", hour12:true
      }).format(new Date()) + " EAT · " + completed + " completed, " + pending + " pending.";
    } catch (error) {
      status.textContent = error.message || "Performance data is temporarily unavailable.";
      totals.innerHTML = "";
      modelGrid.innerHTML = "";
      records.innerHTML = '<div class="dashboard-empty">Could not load tracking data. Please refresh and try again.</div>';
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = "Refresh data";
    }
  }
  refreshButton.addEventListener("click", loadPerformance);
  const performanceSearch = document.getElementById("performance-search");
  if (performanceSearch) performanceSearch.addEventListener("input", function () { renderRecords(allRecords); });
  loadPerformance();
})();