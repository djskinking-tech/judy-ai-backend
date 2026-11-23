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
  function hitLabel(label, hit) {
    if (hit === true) return label + ': HIT';
    if (hit === false) return label + ': MISS';
    return label + ': —';
  }
  function renderRecords(items) {
    if (!items.length) {
      records.innerHTML = '<div class="dashboard-empty">No predictions have been saved yet. Generate a prediction for an upcoming match to start tracking.</div>';
      return;
    }
    records.innerHTML = items.map(function (item) {
      const fixture = item.fixture || {};
      const name = fixture.name || ((fixture.homeTeam || "Home") + " vs " + (fixture.awayTeam || "Away"));
      // The API stores actual scores as strings such as "2-1", not {home, away} objects.
      const ft = item.actual && item.actual.fullTime ? item.actual.fullTime : null;
      const ht = item.actual && item.actual.halfTime ? item.actual.halfTime : null;
      const actualText = item.status === "completed"
        ? "FT " + (ft || "—") + " · HT " + (ht || "—")
        : "Result pending";
      const evaluation = item.evaluation && item.evaluation.v2_1 ? item.evaluation.v2_1 : {};
      const ftHit = evaluation.fullTime ? evaluation.fullTime.topTwo : null;
      const htHit = evaluation.halfTime ? evaluation.halfTime.topTwo : null;
      const outcomeText = item.status === "completed"
        ? hitLabel("FT top two", ftHit) + " · " + hitLabel("HT top two", htHit)
        : "Waiting for final result";
      return '<article class="record-row"><div><strong>' + escapeHtml(name) +
        '</strong><span>' + escapeHtml(fixture.league || "League TBC") + ' · ' +
        escapeHtml(fixture.startingAt || "Kick-off TBC") + '</span></div><div class="record-result ' +
        (item.status === "completed" ? "is-complete" : "") + '">' + escapeHtml(actualText) +
        '<small class="record-outcome">' + escapeHtml(outcomeText) + '</small></div><span class="record-status ' +
        (item.status === "completed" ? "is-complete" : "") + '">' +
        escapeHtml(item.status || "pending") + '</span></article>';
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
  loadPerformance();
})();