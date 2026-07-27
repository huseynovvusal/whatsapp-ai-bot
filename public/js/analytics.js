/**
 * Analytics dashboard.
 *
 * Renders the Analytics tab: a KPI row plus four charts, all scoped to a single
 * time range chosen in the filter row above them. Charts are hand-rolled inline
 * SVG with no external dependencies, so the panel works on an air-gapped host.
 *
 * Conventions (kept deliberately consistent across all four charts):
 *  - one series per chart, so colour never has to carry identity
 *  - marks are thin, gridlines are hairlines, axes recede
 *  - every value reachable without hovering, via direct labels or the table view
 *  - names from WhatsApp are untrusted: always inserted with textContent
 */
(function () {
  "use strict"

  var SVG_NS = "http://www.w3.org/2000/svg"

  var state = {
    days: 7,
    data: null,
    loading: false,
    tables: {} // chartId -> boolean (table view shown)
  }

  // ---------------------------------------------------------------- utilities

  /** Create an SVG element with attributes. */
  function svg(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        node.setAttribute(key, String(attrs[key]))
      })
    }
    return node
  }

  /** Create an HTML element; `text` is set via textContent (never innerHTML). */
  function h(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  /** SVG text node — textContent keeps untrusted labels inert. */
  function svgText(x, y, text, attrs) {
    var node = svg("text", attrs || {})
    node.setAttribute("x", String(x))
    node.setAttribute("y", String(y))
    node.textContent = String(text)
    return node
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString()
  }

  /** Compact form for stat tiles and axis ticks: 1,284 / 12.9K / 4.2M */
  function formatCompact(value) {
    var n = Number(value || 0)
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
    if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K"
    return n.toLocaleString()
  }

  function formatDateLabel(iso) {
    var parts = String(iso).split("-")
    if (parts.length !== 3) return iso
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  }

  function formatHourLabel(hour) {
    return String(hour).padStart(2, "0") + ":00"
  }

  /** Truncate a label to fit an approximate pixel width, without clipping. */
  function truncate(text, maxPx, fontPx) {
    var str = String(text == null ? "" : text)
    var perChar = (fontPx || 12) * 0.58
    var maxChars = Math.max(3, Math.floor(maxPx / perChar))
    if (str.length <= maxChars) return str
    return str.slice(0, maxChars - 1) + "…"
  }

  /**
   * Build an axis scale whose ticks land on round numbers.
   * Picking a nice *step* first (then deriving the max from it) is what keeps
   * ticks clean — choosing a nice max and dividing it by a fixed tick count
   * produces values like 16.667.
   */
  function niceScale(rawMax, targetTicks) {
    var ticksWanted = targetTicks || 4
    if (!rawMax || rawMax <= 0) {
      return { max: ticksWanted, ticks: [0, ticksWanted] }
    }
    var roughStep = rawMax / ticksWanted
    var pow = Math.pow(10, Math.floor(Math.log10(roughStep)))
    var candidates = [1, 2, 2.5, 5, 10].map(function (m) { return m * pow })
    var step = candidates.find(function (c) { return c >= roughStep }) || 10 * pow
    // Whole-number steps only — message counts are never fractional.
    if (step < 1) step = 1
    var max = Math.ceil(rawMax / step) * step
    var ticks = []
    for (var v = 0; v <= max + step * 1e-9; v += step) ticks.push(v)
    return { max: max, ticks: ticks }
  }

  // ------------------------------------------------------------- tooltip layer

  function ensureTooltip(container) {
    var tip = container.querySelector(".chart-tooltip")
    if (!tip) {
      tip = h("div", "chart-tooltip")
      tip.setAttribute("role", "status")
      container.appendChild(tip)
    }
    return tip
  }

  /**
   * Show a tooltip. `rows` is [{label, value}]; the value leads visually because
   * the reader already knows which series they are pointing at.
   */
  function showTooltip(container, x, y, title, rows) {
    var tip = ensureTooltip(container)
    tip.innerHTML = ""
    tip.appendChild(h("div", "chart-tooltip-title", title))
    rows.forEach(function (row) {
      var line = h("div", "chart-tooltip-row")
      line.appendChild(h("span", "chart-tooltip-key"))
      line.appendChild(h("strong", "chart-tooltip-value", formatNumber(row.value)))
      line.appendChild(h("span", "chart-tooltip-label", row.label))
      tip.appendChild(line)
    })
    tip.classList.add("visible")

    // Keep the tooltip inside the card.
    var width = tip.offsetWidth
    var left = Math.max(4, Math.min(x - width / 2, container.clientWidth - width - 4))
    tip.style.left = left + "px"
    tip.style.top = Math.max(0, y) + "px"
  }

  function hideTooltip(container) {
    var tip = container.querySelector(".chart-tooltip")
    if (tip) tip.classList.remove("visible")
  }

  // ------------------------------------------------------------- chart: line

  /**
   * Messages per day — a single series, so no legend: the card title names it.
   * Crosshair snaps to the nearest day so the reader aims at a date, not a line.
   */
  function renderTimeSeries(container, series) {
    container.innerHTML = ""
    if (!series.length) return renderEmpty(container, "No activity in this range")

    var width = Math.max(320, container.clientWidth)
    var plotH = 200
    var axisBand = 28
    var height = plotH + axisBand
    var margin = { top: 16, right: 16, bottom: axisBand, left: 48 }
    var innerW = width - margin.left - margin.right
    var innerH = plotH - margin.top

    var scale = niceScale(Math.max.apply(null, series.map(function (d) { return d.totalMessages })), 4)
    var max = scale.max
    var root = svg("svg", {
      width: width, height: height, viewBox: "0 0 " + width + " " + height,
      class: "chart-svg", role: "img"
    })
    root.appendChild(svgText(-9999, -9999, "Messages per day"))

    var xAt = function (i) {
      return margin.left + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW)
    }
    var yAt = function (v) { return margin.top + innerH - (v / max) * innerH }

    // Gridlines + y ticks (solid hairlines, one step off surface)
    scale.ticks.forEach(function (value) {
      var y = yAt(value)
      root.appendChild(svg("line", {
        x1: margin.left, x2: margin.left + innerW, y1: y, y2: y, class: "chart-grid"
      }))
      root.appendChild(svgText(margin.left - 10, y + 4, formatCompact(value), {
        class: "chart-axis-label", "text-anchor": "end"
      }))
    })

    // Area wash + 2px line
    var linePoints = series.map(function (d, i) { return xAt(i) + "," + yAt(d.totalMessages) })
    var areaPath = "M" + xAt(0) + "," + yAt(0) + "L" + linePoints.join("L") +
      "L" + xAt(series.length - 1) + "," + yAt(0) + "Z"
    root.appendChild(svg("path", { d: areaPath, class: "chart-area" }))
    root.appendChild(svg("polyline", { points: linePoints.join(" "), class: "chart-line" }))

    // X labels: ~6 evenly spaced, never one per day
    var labelStep = Math.max(1, Math.ceil(series.length / 6))
    series.forEach(function (d, i) {
      if (i % labelStep !== 0 && i !== series.length - 1) return
      root.appendChild(svgText(xAt(i), plotH + 18, formatDateLabel(d.date), {
        class: "chart-axis-label", "text-anchor": i === series.length - 1 ? "end" : "middle"
      }))
    })

    // Direct-label the endpoint only (selective labelling)
    var lastIndex = series.length - 1
    var last = series[lastIndex]
    root.appendChild(svg("circle", {
      cx: xAt(lastIndex), cy: yAt(last.totalMessages), r: 4, class: "chart-dot"
    }))
    root.appendChild(svgText(xAt(lastIndex) - 8, yAt(last.totalMessages) - 10,
      formatNumber(last.totalMessages), { class: "chart-value-label", "text-anchor": "end" }))

    // Hover layer
    var crosshair = svg("line", { class: "chart-crosshair", y1: margin.top, y2: margin.top + innerH })
    crosshair.style.display = "none"
    root.appendChild(crosshair)
    var hoverDot = svg("circle", { r: 5, class: "chart-dot-hover" })
    hoverDot.style.display = "none"
    root.appendChild(hoverDot)

    var overlay = svg("rect", {
      x: margin.left, y: margin.top, width: innerW, height: innerH,
      fill: "transparent", class: "chart-overlay", tabindex: "0"
    })
    function moveTo(index) {
      var d = series[index]
      if (!d) return
      var x = xAt(index)
      var y = yAt(d.totalMessages)
      crosshair.setAttribute("x1", x)
      crosshair.setAttribute("x2", x)
      crosshair.style.display = ""
      hoverDot.setAttribute("cx", x)
      hoverDot.setAttribute("cy", y)
      hoverDot.style.display = ""
      showTooltip(container, x, Math.max(0, y - 72), formatDateLabel(d.date), [
        { label: "messages", value: d.totalMessages },
        { label: "AI calls", value: d.apiCalls }
      ])
    }
    overlay.addEventListener("pointermove", function (ev) {
      var rect = root.getBoundingClientRect()
      var scale = width / rect.width
      var px = (ev.clientX - rect.left) * scale
      var ratio = (px - margin.left) / innerW
      moveTo(Math.max(0, Math.min(series.length - 1, Math.round(ratio * (series.length - 1)))))
    })
    overlay.addEventListener("pointerleave", function () {
      crosshair.style.display = "none"
      hoverDot.style.display = "none"
      hideTooltip(container)
    })
    // Keyboard parity with hover
    var focusIndex = series.length - 1
    overlay.addEventListener("focus", function () { moveTo(focusIndex) })
    overlay.addEventListener("blur", function () {
      crosshair.style.display = "none"
      hoverDot.style.display = "none"
      hideTooltip(container)
    })
    overlay.addEventListener("keydown", function (ev) {
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return
      ev.preventDefault()
      focusIndex = Math.max(0, Math.min(series.length - 1,
        focusIndex + (ev.key === "ArrowRight" ? 1 : -1)))
      moveTo(focusIndex)
    })
    root.appendChild(overlay)

    container.appendChild(root)
  }

  // ----------------------------------------------------------- chart: columns

  /** Activity by hour — the mark is the hit target, so no crosshair. */
  function renderColumns(container, buckets) {
    container.innerHTML = ""
    var total = buckets.reduce(function (sum, b) { return sum + b.count }, 0)
    if (!total) return renderEmpty(container, "No activity in this range")

    var width = Math.max(320, container.clientWidth)
    var plotH = 180
    var axisBand = 26
    var height = plotH + axisBand
    var margin = { top: 16, right: 8, bottom: axisBand, left: 40 }
    var innerW = width - margin.left - margin.right
    var innerH = plotH - margin.top

    var scale = niceScale(Math.max.apply(null, buckets.map(function (b) { return b.count })), 3)
    var max = scale.max
    var band = innerW / buckets.length
    var barW = Math.min(24, band - 2) // 2px surface gap between neighbours

    var root = svg("svg", {
      width: width, height: height, viewBox: "0 0 " + width + " " + height,
      class: "chart-svg", role: "img"
    })

    scale.ticks.forEach(function (value) {
      var y = margin.top + innerH - (value / max) * innerH
      root.appendChild(svg("line", {
        x1: margin.left, x2: margin.left + innerW, y1: y, y2: y, class: "chart-grid"
      }))
      root.appendChild(svgText(margin.left - 8, y + 4, formatCompact(value), {
        class: "chart-axis-label", "text-anchor": "end"
      }))
    })

    buckets.forEach(function (bucket, i) {
      var barH = max ? (bucket.count / max) * innerH : 0
      var x = margin.left + i * band + (band - barW) / 2
      var y = margin.top + innerH - barH
      // 4px rounded cap, square at the baseline
      var r = Math.min(4, barH)
      var bar = svg("path", {
        d: barH <= 0 ? "" :
          "M" + x + "," + (y + barH) +
          "L" + x + "," + (y + r) +
          "Q" + x + "," + y + " " + (x + r) + "," + y +
          "L" + (x + barW - r) + "," + y +
          "Q" + (x + barW) + "," + y + " " + (x + barW) + "," + (y + r) +
          "L" + (x + barW) + "," + (y + barH) + "Z",
        class: "chart-bar"
      })
      root.appendChild(bar)

      // Hit target spans the full band and the plot height (bigger than the mark)
      var hit = svg("rect", {
        x: margin.left + i * band, y: margin.top, width: band, height: innerH,
        fill: "transparent", class: "chart-hit"
      })
      hit.addEventListener("pointerenter", function () {
        bar.classList.add("is-hover")
        showTooltip(container, margin.left + i * band + band / 2, Math.max(0, y - 64),
          formatHourLabel(bucket.hour), [{ label: "messages", value: bucket.count }])
      })
      hit.addEventListener("pointerleave", function () {
        bar.classList.remove("is-hover")
        hideTooltip(container)
      })
      root.appendChild(hit)

      if (bucket.hour % 6 === 0) {
        root.appendChild(svgText(margin.left + i * band + band / 2, plotH + 16,
          formatHourLabel(bucket.hour), { class: "chart-axis-label", "text-anchor": "middle" }))
      }
    })

    container.appendChild(root)
  }

  // -------------------------------------------------------- chart: horizontal

  /**
   * Ranked horizontal bars (top people / top chats). Nominal categories, so every
   * bar takes the same colour — bar length already encodes magnitude.
   */
  function renderRankedBars(container, rows) {
    container.innerHTML = ""
    if (!rows.length) return renderEmpty(container, "No activity in this range")

    var width = Math.max(320, container.clientWidth)
    var rowH = 34
    var height = rows.length * rowH + 12
    var labelW = Math.min(160, Math.max(96, width * 0.34))
    var valueW = 52
    var trackX = labelW + 12
    var trackW = Math.max(40, width - trackX - valueW)
    var max = Math.max.apply(null, rows.map(function (r) { return r.count })) || 1
    var barH = Math.min(18, rowH - 14)

    var root = svg("svg", {
      width: width, height: height, viewBox: "0 0 " + width + " " + height,
      class: "chart-svg", role: "img"
    })

    rows.forEach(function (row, i) {
      var y = i * rowH + 8
      var barW = Math.max(2, (row.count / max) * trackW)
      var r = Math.min(4, barW)

      var label = svgText(0, y + barH / 2 + 4, truncate(row.label, labelW - 8, 12), {
        class: "chart-row-label"
      })
      var title = svg("title")
      title.textContent = row.label // full, untruncated name on hover
      label.appendChild(title)
      root.appendChild(label)

      // Rounded data-end, square at the baseline
      var bar = svg("path", {
        d: "M" + trackX + "," + y +
          "L" + (trackX + barW - r) + "," + y +
          "Q" + (trackX + barW) + "," + y + " " + (trackX + barW) + "," + (y + r) +
          "L" + (trackX + barW) + "," + (y + barH - r) +
          "Q" + (trackX + barW) + "," + (y + barH) + " " + (trackX + barW - r) + "," + (y + barH) +
          "L" + trackX + "," + (y + barH) + "Z",
        class: "chart-bar"
      })
      root.appendChild(bar)

      // Value at the tip
      root.appendChild(svgText(width - 4, y + barH / 2 + 4, formatNumber(row.count), {
        class: "chart-value-label", "text-anchor": "end"
      }))

      var hit = svg("rect", {
        x: 0, y: i * rowH, width: width, height: rowH, fill: "transparent", class: "chart-hit"
      })
      hit.addEventListener("pointerenter", function () {
        bar.classList.add("is-hover")
        showTooltip(container, trackX + barW / 2, Math.max(0, y - 58), row.label,
          [{ label: row.unit || "messages", value: row.count }])
      })
      hit.addEventListener("pointerleave", function () {
        bar.classList.remove("is-hover")
        hideTooltip(container)
      })
      root.appendChild(hit)
    })

    container.appendChild(root)
  }

  function renderEmpty(container, message) {
    var wrap = h("div", "chart-empty")
    wrap.appendChild(h("div", "chart-empty-icon", "📊"))
    wrap.appendChild(h("p", null, message))
    container.appendChild(wrap)
  }

  // ------------------------------------------------------------- table views

  function renderTable(container, columns, rows) {
    container.innerHTML = ""
    var table = h("table", "chart-table")
    var thead = h("thead")
    var headRow = h("tr")
    columns.forEach(function (col) { headRow.appendChild(h("th", null, col)) })
    thead.appendChild(headRow)
    table.appendChild(thead)

    var tbody = h("tbody")
    rows.forEach(function (row) {
      var tr = h("tr")
      row.forEach(function (cell, i) {
        tr.appendChild(h("td", i === 0 ? null : "num", cell))
      })
      tbody.appendChild(tr)
    })
    table.appendChild(tbody)
    container.appendChild(table)
  }

  // ------------------------------------------------------------- stat tiles

  function renderStats(data) {
    var host = document.getElementById("analytics-stats")
    if (!host) return
    host.innerHTML = ""

    var totals = data.totals || {}
    var previous = data.previous || {}

    var tiles = [
      { label: "Messages", value: totals.messages, prev: previous.messages },
      { label: "AI calls", value: totals.apiCalls, prev: null },
      { label: "Tokens used", value: totals.tokensUsed, prev: null },
      { label: "Active people", value: totals.activeUsers, prev: previous.activeUsers }
    ]

    tiles.forEach(function (tile) {
      var card = h("div", "stat-card")
      card.appendChild(h("div", "stat-title", tile.label))
      card.appendChild(h("div", "stat-value", formatCompact(tile.value)))

      // A delta needs a non-zero baseline; without one, state the window instead
      // of showing a meaningless "vs previous" with no number.
      if (tile.prev) {
        var pct = Math.round(((tile.value - tile.prev) / tile.prev) * 100)
        var arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "•"
        var change = h("div", "stat-change")
        change.appendChild(h("span", pct > 0 ? "delta-up" : pct < 0 ? "delta-down" : "delta-flat",
          arrow + " " + Math.abs(pct) + "%"))
        change.appendChild(document.createTextNode(" vs previous " + data.days + " days"))
        card.appendChild(change)
      } else {
        card.appendChild(h("div", "stat-change", "in the last " + data.days + " days"))
      }
      host.appendChild(card)
    })
  }

  // ----------------------------------------------------------------- rendering

  function renderAll() {
    var data = state.data
    if (!data) return

    renderStats(data)

    var series = data.series || []
    var hourly = data.hourly || []
    var topUsers = (data.topUsers || []).map(function (u) {
      return { label: u.senderName || u.sender, count: u.count }
    })
    var topChats = (data.topChats || []).map(function (c) {
      return { label: c.chatName || c.chatId, count: c.count }
    })

    var timeHost = document.getElementById("chart-timeseries")
    if (timeHost) {
      if (state.tables.timeseries) {
        renderTable(timeHost, ["Date", "Messages", "AI calls", "Tokens"],
          series.map(function (d) {
            return [formatDateLabel(d.date), formatNumber(d.totalMessages),
              formatNumber(d.apiCalls), formatNumber(d.tokensUsed)]
          }))
      } else {
        renderTimeSeries(timeHost, series)
      }
    }

    var hourHost = document.getElementById("chart-hourly")
    if (hourHost) {
      if (state.tables.hourly) {
        renderTable(hourHost, ["Hour", "Messages"],
          hourly.map(function (b) { return [formatHourLabel(b.hour), formatNumber(b.count)] }))
      } else {
        renderColumns(hourHost, hourly)
      }
    }

    var usersHost = document.getElementById("chart-top-users")
    if (usersHost) {
      if (state.tables.users) {
        renderTable(usersHost, ["Person", "Messages"],
          topUsers.map(function (r) { return [r.label, formatNumber(r.count)] }))
      } else {
        renderRankedBars(usersHost, topUsers)
      }
    }

    var chatsHost = document.getElementById("chart-top-chats")
    if (chatsHost) {
      if (state.tables.chats) {
        renderTable(chatsHost, ["Chat", "Messages"],
          topChats.map(function (r) { return [r.label, formatNumber(r.count)] }))
      } else {
        renderRankedBars(chatsHost, topChats)
      }
    }
  }

  // ------------------------------------------------------------------ loading

  function setLoading(loading) {
    state.loading = loading
    var grid = document.getElementById("analytics-content")
    // Hold the previous render at reduced opacity — no skeleton, no layout jump.
    if (grid) grid.classList.toggle("is-loading", loading)
  }

  function loadAnalytics() {
    setLoading(true)
    return fetch("/api/analytics?days=" + state.days)
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed: " + res.status)
        return res.json()
      })
      .then(function (data) {
        state.data = data
        renderAll()
      })
      .catch(function (err) {
        console.error("Failed to load analytics:", err)
        var host = document.getElementById("chart-timeseries")
        if (host) {
          host.innerHTML = ""
          renderEmpty(host, "Could not load analytics data")
        }
      })
      .finally(function () { setLoading(false) })
  }

  // -------------------------------------------------------------------- wiring

  function initControls() {
    document.querySelectorAll("[data-range]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var days = Number(btn.getAttribute("data-range"))
        if (!days || days === state.days) return
        state.days = days
        document.querySelectorAll("[data-range]").forEach(function (other) {
          other.classList.toggle("active", other === btn)
          other.setAttribute("aria-pressed", other === btn ? "true" : "false")
        })
        loadAnalytics()
      })
    })

    document.querySelectorAll("[data-table-toggle]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-table-toggle")
        state.tables[key] = !state.tables[key]
        btn.textContent = state.tables[key] ? "Chart view" : "Table view"
        btn.setAttribute("aria-pressed", state.tables[key] ? "true" : "false")
        renderAll()
      })
    })

    // Re-render on resize so text stays crisp instead of being scaled by the SVG.
    var resizeTimer = null
    window.addEventListener("resize", function () {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(function () {
        if (state.data) renderAll()
      }, 150)
    })
  }

  // The Analytics tab starts hidden; charts need a measurable width, so render on
  // first reveal rather than at page load.
  var initialised = false
  window.initAnalyticsTab = function () {
    if (!initialised) {
      initialised = true
      initControls()
      loadAnalytics()
    } else if (state.data) {
      renderAll()
    }
  }

  window.refreshAnalytics = loadAnalytics
})()
