/**
 * People and Memory (RAG) tabs.
 *
 * All values rendered here originate from WhatsApp display names and message
 * text, which are untrusted input — everything goes into the DOM via
 * textContent, never innerHTML string concatenation.
 */
(function () {
  "use strict"

  var peopleCache = []
  var chatsCache = []

  // ------------------------------------------------------------------ helpers

  function h(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function formatDate(ms) {
    if (!ms) return "—"
    return new Date(Number(ms)).toLocaleString()
  }

  function relativeDate(ms) {
    if (!ms) return "—"
    var diff = Date.now() - Number(ms)
    var mins = Math.floor(diff / 60000)
    if (mins < 1) return "just now"
    if (mins < 60) return mins + "m ago"
    var hours = Math.floor(mins / 60)
    if (hours < 24) return hours + "h ago"
    var days = Math.floor(hours / 24)
    if (days < 30) return days + "d ago"
    return new Date(Number(ms)).toLocaleDateString()
  }

  function emptyRow(colspan, message) {
    var tr = h("tr")
    var td = h("td")
    td.setAttribute("colspan", String(colspan))
    var wrap = h("div", "empty-state")
    wrap.appendChild(h("p", null, message))
    td.appendChild(wrap)
    tr.appendChild(td)
    return tr
  }

  function labelled(label, value) {
    var row = h("div", "detail-row")
    row.appendChild(h("span", "detail-label", label))
    row.appendChild(h("span", "detail-value", value))
    return row
  }

  // -------------------------------------------------------------- people tab

  function loadPeople() {
    fetch("/api/me")
      .then(function (r) { return r.json() })
      .then(function (me) {
        var host = document.getElementById("me-card")
        if (!host) return
        host.innerHTML = ""
        if (!me.connected) {
          host.appendChild(h("p", "muted-note", "Not connected to WhatsApp — link a device from the Logs tab."))
          return
        }
        var grid = h("div", "detail-grid")
        grid.appendChild(labelled("Display name", me.name || "—"))
        grid.appendChild(labelled("Number", me.phone || "—"))
        grid.appendChild(labelled("JID", me.jid || "—"))
        host.appendChild(grid)
      })
      .catch(function (err) { console.error("Failed to load own identity:", err) })

    fetch("/api/users")
      .then(function (r) { return r.json() })
      .then(function (data) {
        peopleCache = data.users || []
        renderPeople()
      })
      .catch(function (err) {
        console.error("Failed to load people:", err)
        var tbody = document.getElementById("people-list")
        if (tbody) {
          tbody.innerHTML = ""
          tbody.appendChild(emptyRow(6, "Could not load people"))
        }
      })

    // Populate the chat pickers (used by participants + recall scope)
    fetch("/api/conversations")
      .then(function (r) { return r.json() })
      .then(function (data) {
        chatsCache = data.conversations || []
        fillChatSelect("participants-chat-select", "Select a chat…")
        fillChatSelect("knowledge-scope", "All chats")
      })
      .catch(function (err) { console.error("Failed to load chats:", err) })
  }

  function fillChatSelect(id, placeholder) {
    var select = document.getElementById(id)
    if (!select) return
    var previous = select.value
    select.innerHTML = ""
    var first = h("option", null, placeholder)
    first.value = ""
    select.appendChild(first)
    chatsCache.forEach(function (chat) {
      var option = h("option", null, (chat.name || chat.id) + (chat.id.endsWith("@g.us") ? " (group)" : ""))
      option.value = chat.id
      select.appendChild(option)
    })
    if (previous) select.value = previous
  }

  function renderPeople() {
    var tbody = document.getElementById("people-list")
    if (!tbody) return
    var term = ((document.getElementById("people-search") || {}).value || "").toLowerCase().trim()

    var rows = peopleCache.filter(function (person) {
      if (!term) return true
      var name = (person.displayName || person.pushName || "").toLowerCase()
      return name.indexOf(term) !== -1 || String(person.phoneNumber).indexOf(term) !== -1
    })

    tbody.innerHTML = ""
    if (!rows.length) {
      tbody.appendChild(emptyRow(6, term ? "No matches" : "Nobody seen yet"))
      return
    }

    rows.forEach(function (person) {
      var tr = h("tr")
      tr.appendChild(h("td", null, person.displayName || person.pushName || "(unknown)"))

      var phoneCell = h("td")
      phoneCell.appendChild(h("code", "mono-cell", person.phoneNumber))
      tr.appendChild(phoneCell)

      tr.appendChild(h("td", null, Number(person.messageCount || 0).toLocaleString()))
      tr.appendChild(h("td", null, person.chatCount || 0))
      tr.appendChild(h("td", null, relativeDate(person.lastSeen)))

      var actions = h("td")
      var btn = h("button", "btn btn-secondary btn-sm", "Details")
      btn.addEventListener("click", function () { showPerson(person.phoneNumber) })
      actions.appendChild(btn)
      tr.appendChild(actions)

      tbody.appendChild(tr)
    })
  }

  function showPerson(phone) {
    fetch("/api/users/" + encodeURIComponent(phone))
      .then(function (r) {
        if (!r.ok) throw new Error("not found")
        return r.json()
      })
      .then(function (data) {
        var card = document.getElementById("person-detail-card")
        var body = document.getElementById("person-detail-body")
        var title = document.getElementById("person-detail-title")
        if (!card || !body) return

        title.textContent = data.profile.displayName || data.profile.pushName || data.profile.phoneNumber
        body.innerHTML = ""

        var grid = h("div", "detail-grid")
        grid.appendChild(labelled("Number", data.profile.phoneNumber))
        grid.appendChild(labelled("Display name", data.profile.displayName || "—"))
        grid.appendChild(labelled("WhatsApp push name", data.profile.pushName || "—"))
        grid.appendChild(labelled("Bot admin", data.profile.isAdmin ? "Yes" : "No"))
        grid.appendChild(labelled("First seen", formatDate(data.profile.firstSeen)))
        grid.appendChild(labelled("Last seen", formatDate(data.profile.lastSeen)))
        grid.appendChild(labelled("Total messages", Number(data.activity.totalMessages || 0).toLocaleString()))
        body.appendChild(grid)

        body.appendChild(h("h3", "detail-heading", "Chats"))
        if (!data.activity.chats.length) {
          body.appendChild(h("p", "muted-note", "No chats recorded."))
        } else {
          var list = h("div", "access-list")
          data.activity.chats.forEach(function (chat) {
            var item = h("div", "access-item")
            var info = h("div", "access-item-info")
            info.appendChild(h("div", "access-item-id", chat.chatName || chat.chatId))
            var meta = h("div", "access-item-meta")
            meta.appendChild(h("span", "access-item-badge " + (chat.isGroup ? "group" : "contact"),
              chat.isGroup ? "group" : "contact"))
            meta.appendChild(h("span", null, chat.count + " messages"))
            info.appendChild(meta)
            item.appendChild(info)
            list.appendChild(item)
          })
          body.appendChild(list)
        }

        body.appendChild(h("h3", "detail-heading", "Recent messages"))
        if (!data.recentMessages.length) {
          body.appendChild(h("p", "muted-note", "No messages recorded."))
        } else {
          var msgs = h("div", "message-list")
          data.recentMessages.forEach(function (message) {
            var item = h("div", "message-item")
            var head = h("div", "message-meta")
            head.appendChild(h("span", null, formatDate(message.timestamp)))
            item.appendChild(head)
            item.appendChild(h("div", "message-text", message.text))
            msgs.appendChild(item)
          })
          body.appendChild(msgs)
        }

        card.style.display = ""
        card.scrollIntoView({ behavior: "smooth", block: "start" })
      })
      .catch(function (err) {
        console.error("Failed to load person:", err)
        if (typeof showAlert === "function") showAlert("error", "Could not load that person")
      })
  }

  function closePersonDetail() {
    var card = document.getElementById("person-detail-card")
    if (card) card.style.display = "none"
  }

  function loadParticipants() {
    var select = document.getElementById("participants-chat-select")
    var host = document.getElementById("participants-body")
    if (!select || !host) return
    var chatId = select.value
    if (!chatId) {
      host.innerHTML = ""
      host.appendChild(h("p", "muted-note", "Pick a chat to see who is in it."))
      return
    }

    host.innerHTML = ""
    host.appendChild(h("p", "muted-note", "Loading…"))

    fetch("/api/chats/" + encodeURIComponent(chatId) + "/participants")
      .then(function (r) { return r.json() })
      .then(function (data) {
        host.innerHTML = ""

        if (data.groupInfo) {
          var grid = h("div", "detail-grid")
          grid.appendChild(labelled("Subject", data.groupInfo.subject || "—"))
          grid.appendChild(labelled("Owner", data.groupInfo.owner || "—"))
          grid.appendChild(labelled("Participants", data.groupInfo.participantCount))
          host.appendChild(grid)
        }

        if (!data.participants.length) {
          host.appendChild(h("p", "muted-note",
            data.isGroup
              ? "No participants returned. The bot may not be connected, or is not a member of this group."
              : "No participants recorded for this chat."))
          return
        }

        var table = h("table")
        var thead = h("thead")
        var headRow = h("tr")
        ;["Name", "Number", "Role", "Messages", "Last message"].forEach(function (col) {
          headRow.appendChild(h("th", null, col))
        })
        thead.appendChild(headRow)
        table.appendChild(thead)

        var tbody = h("tbody")
        data.participants.forEach(function (person) {
          var tr = h("tr")
          tr.appendChild(h("td", null, person.name || "(unknown)"))
          var phoneCell = h("td")
          phoneCell.appendChild(h("code", "mono-cell", person.phone))
          tr.appendChild(phoneCell)

          var roleCell = h("td")
          if (person.isGroupAdmin) roleCell.appendChild(h("span", "badge badge-info", "Group admin"))
          if (person.isBotAdmin) roleCell.appendChild(h("span", "badge badge-success", "Bot admin"))
          if (!person.isGroupAdmin && !person.isBotAdmin) roleCell.textContent = "Member"
          tr.appendChild(roleCell)

          tr.appendChild(h("td", null, Number(person.messageCount || 0).toLocaleString()))
          tr.appendChild(h("td", null, relativeDate(person.lastMessageAt)))
          tbody.appendChild(tr)
        })
        table.appendChild(tbody)

        var wrap = h("div", "table-container")
        wrap.appendChild(table)
        host.appendChild(wrap)
      })
      .catch(function (err) {
        console.error("Failed to load participants:", err)
        host.innerHTML = ""
        host.appendChild(h("p", "muted-note", "Could not load participants."))
      })
  }

  // ------------------------------------------------------------ knowledge tab

  function loadKnowledge() {
    if (!chatsCache.length) {
      fetch("/api/conversations")
        .then(function (r) { return r.json() })
        .then(function (data) {
          chatsCache = data.conversations || []
          fillChatSelect("knowledge-scope", "All chats")
        })
        .catch(function () { /* selector stays as "All chats" */ })
    }

    fetch("/api/knowledge/status")
      .then(function (r) { return r.json() })
      .then(function (status) {
        var host = document.getElementById("knowledge-status")
        if (!host) return
        host.innerHTML = ""

        if (!status.configured) {
          var warn = h("div", "inline-warning")
          warn.appendChild(h("strong", null, "No embedding provider configured. "))
          warn.appendChild(document.createTextNode(
            "Add an API key for your LLM provider in Settings — embeddings use the same key."))
          host.appendChild(warn)
        }

        var grid = h("div", "detail-grid")
        grid.appendChild(labelled("Recall", status.enabled ? "Enabled" : "Disabled"))
        grid.appendChild(labelled("Embedding model", status.model || "—"))
        grid.appendChild(labelled("Indexed chunks", Number(status.stats.chunks || 0).toLocaleString()))
        grid.appendChild(labelled("Chats covered", status.stats.chats || 0))
        grid.appendChild(labelled("Status", status.indexing ? "Indexing…" : "Idle"))
        grid.appendChild(labelled("Oldest memory",
          status.stats.oldest ? new Date(status.stats.oldest).toLocaleDateString() : "—"))
        host.appendChild(grid)

        if (status.stats.models && status.stats.models.length > 1) {
          var note = h("p", "muted-note",
            "Multiple embedding models present (" + status.stats.models.join(", ") +
            "). Only chunks matching the active model are searchable — rebuild to consolidate.")
          host.appendChild(note)
        }
      })
      .catch(function (err) { console.error("Failed to load knowledge status:", err) })
  }

  function knowledgeAction(url, options, successMessage) {
    if (typeof showAlert === "function") showAlert("success", "Working…")
    return fetch(url, options)
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b } }) })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body.error || "Request failed")
        if (typeof showAlert === "function") {
          showAlert("success", successMessage(res.body))
        }
        loadKnowledge()
      })
      .catch(function (err) {
        console.error(err)
        if (typeof showAlert === "function") showAlert("error", String(err.message || err))
      })
  }

  function indexKnowledge() {
    knowledgeAction("/api/knowledge/index", { method: "POST" }, function (body) {
      if (body.skipped) return "Nothing indexed: " + body.skipped
      return "Indexed " + body.chunks + " new chunk(s) across " + body.chats + " chat(s)"
    })
  }

  function reindexKnowledge() {
    if (!confirm("Rebuild the entire knowledge base? Existing chunks are discarded and re-embedded, which uses API credit.")) return
    knowledgeAction("/api/knowledge/reindex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }, function (body) {
      return "Rebuilt: " + body.chunks + " chunk(s) across " + body.chats + " chat(s)"
    })
  }

  function clearKnowledge() {
    if (!confirm("Delete every stored memory? The bot will lose long-term recall until re-indexed.")) return
    knowledgeAction("/api/knowledge", { method: "DELETE" }, function (body) {
      return "Removed " + body.removed + " chunk(s)"
    })
  }

  function searchKnowledge() {
    var input = document.getElementById("knowledge-query")
    var scope = document.getElementById("knowledge-scope")
    var host = document.getElementById("knowledge-results")
    if (!input || !host) return

    var query = (input.value || "").trim()
    if (!query) {
      host.innerHTML = ""
      host.appendChild(h("p", "muted-note", "Enter a question to test recall."))
      return
    }

    host.innerHTML = ""
    host.appendChild(h("p", "muted-note", "Searching…"))

    var url = "/api/knowledge/search?q=" + encodeURIComponent(query)
    if (scope && scope.value) url += "&chatId=" + encodeURIComponent(scope.value)

    fetch(url)
      .then(function (r) { return r.json() })
      .then(function (data) {
        host.innerHTML = ""
        if (!data.results || !data.results.length) {
          host.appendChild(h("p", "muted-note",
            "No memories matched. Try indexing first, or lower the relevance threshold in Settings."))
          return
        }
        data.results.forEach(function (hit) {
          var item = h("div", "memory-item")
          var head = h("div", "memory-meta")
          var score = h("span", "memory-score", hit.score.toFixed(3))
          head.appendChild(score)
          head.appendChild(h("span", null, hit.chatName || hit.chatId))
          head.appendChild(h("span", null, new Date(hit.endTimestamp).toLocaleDateString()))
          item.appendChild(head)
          item.appendChild(h("pre", "memory-text", hit.text))
          host.appendChild(item)
        })
      })
      .catch(function (err) {
        console.error("Recall test failed:", err)
        host.innerHTML = ""
        host.appendChild(h("p", "muted-note", "Search failed."))
      })
  }

  // Enter key runs the recall search
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter") return
    if (ev.target && ev.target.id === "knowledge-query") {
      ev.preventDefault()
      searchKnowledge()
    }
  })

  // Exposed for the inline onclick handlers in admin.ejs
  window.loadPeople = loadPeople
  window.renderPeople = renderPeople
  window.loadParticipants = loadParticipants
  window.closePersonDetail = closePersonDetail
  window.loadKnowledge = loadKnowledge
  window.indexKnowledge = indexKnowledge
  window.reindexKnowledge = reindexKnowledge
  window.clearKnowledge = clearKnowledge
  window.searchKnowledge = searchKnowledge
})()
