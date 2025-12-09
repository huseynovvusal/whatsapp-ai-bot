// Small client script to manage saving to localStorage and sending updates to server
// Small client script to manage saving to localStorage and sending updates to server
(function(){
  const form = document.getElementById('settingsForm')
  const status = document.getElementById('status')
  const resetLocal = document.getElementById('resetLocal')

  // Guard: if critical UI pieces are missing, stop early to avoid runtime exceptions
  if (!form) {
    console.warn('Admin form not found on the page; aborting admin.js')
    return
  }

  // Helper getters for safe DOM access
  /** @param {string} id */
  function getInput(id){
    const el = document.getElementById(id)
    if (!el) return null
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el
    return null
  }
  /** @param {string} id */
  function getCheckbox(id){
    const el = document.getElementById(id)
    if (!el) return null
    if (el instanceof HTMLInputElement && el.type === 'checkbox') return el
    return null
  }

  function saveToLocal(){
    const state = {
      botName: (getInput('botName') || { value: '' }).value,
  adminNumbers: (getInput('adminNumbers') || { value: '' }).value,
      systemPrompt: (getInput('systemPrompt') || { value: '' }).value,
      rateLimitMaxRequests: (getInput('rateLimitMaxRequests') || { value: '' }).value,
      rateLimitWindowMs: (getInput('rateLimitWindowMs') || { value: '' }).value,
      geminiApiKey: (getInput('geminiApiKey') || { value: '' }).value,
  // read the checkbox safely
  enablePrivateChat: !!(function(){ const el = getCheckbox('enablePrivateChat'); return el && el.checked })(),
  respondToGroupMessages: !!(function(){ const el = getCheckbox('respondToGroupMessages'); return el && el.checked })()
  ,contextualGroupResponses: !!(function(){ const el = getCheckbox('contextualGroupResponses'); const parent = getCheckbox('respondToGroupMessages'); return el && el.checked && parent && parent.checked })()
    }
    localStorage.setItem('whatsapp.bot.settings', JSON.stringify(state))
  }

  function loadFromLocal(){
  const raw = localStorage.getItem('whatsapp.bot.settings')
    if(!raw) return
    try{
      const state = JSON.parse(raw)
      {
        const el = getInput('botName'); if (state.botName && el) el.value = state.botName
      }
      {
        const el = getInput('adminNumbers'); if (state.adminNumbers && el) el.value = state.adminNumbers
      }
      {
        const el = getInput('systemPrompt'); if (state.systemPrompt && el) el.value = state.systemPrompt
      }
      {
        const el = getInput('rateLimitMaxRequests'); if (state.rateLimitMaxRequests && el) el.value = state.rateLimitMaxRequests
      }
      {
        const el = getInput('rateLimitWindowMs'); if (state.rateLimitWindowMs && el) el.value = state.rateLimitWindowMs
      }
      {
        const el = getInput('geminiApiKey'); if (state.geminiApiKey && el) el.value = state.geminiApiKey
      }
        {
          const el = getCheckbox('enablePrivateChat'); if (typeof state.enablePrivateChat !== 'undefined' && el) el.checked = state.enablePrivateChat
        }
        {
          const el = getCheckbox('respondToGroupMessages'); if (typeof state.respondToGroupMessages !== 'undefined' && el) el.checked = state.respondToGroupMessages
        }
        {
          const el = getCheckbox('contextualGroupResponses'); if (typeof state.contextualGroupResponses !== 'undefined' && el) el.checked = state.contextualGroupResponses
        }
    }catch(e){console.warn('Invalid local settings')}
  }

  form.addEventListener('submit', async (e)=>{
    e.preventDefault()
  saveToLocal()
  if (status) status.textContent = 'Saving...'

    const body = {
      botName: (getInput('botName') || { value: '' }).value,
      adminNumbers: (getInput('adminNumbers') || { value: '' }).value,
      systemPrompt: (getInput('systemPrompt') || { value: '' }).value,
      rateLimitMaxRequests: Number((getInput('rateLimitMaxRequests') || { value: 0 }).value),
      rateLimitWindowMs: Number((getInput('rateLimitWindowMs') || { value: 0 }).value),
      geminiApiKey: (getInput('geminiApiKey') || { value: '' }).value,
  enablePrivateChat: !!(function(){ const el = getCheckbox('enablePrivateChat'); return el && el.checked })(),
  respondToGroupMessages: !!(function(){ const el = getCheckbox('respondToGroupMessages'); return el && el.checked })(),
  contextualGroupResponses: !!(function(){ const el = getCheckbox('contextualGroupResponses'); const parent = getCheckbox('respondToGroupMessages'); return el && el.checked && parent && parent.checked })()
    }

    // Validate inputs before POSTing
    clearErrors()
    const valid = validateForm()
    if (!valid) {
      if (status) status.textContent = 'Please fix the highlighted errors.'
      return
    }

    try{
      const r = await fetch('/admin/save', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body)
      })
      const json = await r.json()
  if (status) {
        if(json.success){
          status.textContent = 'Saved successfully.'
          status.classList.add('saved')
        }else{
          status.textContent = 'Failed to save settings.'
          status.classList.remove('saved')
        }
      }
    }catch(e){
  if (status) status.textContent = 'Error saving settings.'
      console.error(e)
    }

  setTimeout(()=>{ if (status) { status.textContent = ''; status.classList.remove('saved') } }, 3000)
  })

  if (resetLocal) resetLocal.addEventListener('click', ()=>{
    localStorage.removeItem('whatsapp.bot.settings')
    if (status) status.textContent = 'Local settings cleared.'
    setTimeout(()=>{ if (status) status.textContent = '' }, 2000)
  })

  // Load local settings if present
  loadFromLocal()
  // Show/hide contextual toggle based on group toggle state
  const parentGroupCheck = getCheckbox('respondToGroupMessages')
  const contextualCheck = getCheckbox('contextualGroupResponses')
  const groupContextRow = document.getElementById('groupContextRow')
  function updateContextualToggleVisibility(){
    if (!groupContextRow || !parentGroupCheck) return
    if (parentGroupCheck.checked){
      groupContextRow.style.display = ''
      if (contextualCheck) contextualCheck.disabled = false
    } else {
      groupContextRow.style.display = 'none'
      if (contextualCheck){ contextualCheck.disabled = true; contextualCheck.checked = false }
    }
  }
  if (parentGroupCheck) parentGroupCheck.addEventListener('change', updateContextualToggleVisibility)
  // initial run
  updateContextualToggleVisibility()
  // Fetch and render conversation list
  async function fetchConversations(){
    try{
      const r = await fetch('/admin/api/conversations')
      const json = await r.json()
  /** @type {{id:string,count:number,name?:string}[]} */
  const list = json.conversations || []
  const container = document.getElementById('convoList')
  if(!container) return
      container.innerHTML = ''
      if(!list.length){
        container.innerHTML = '<p class="subtitle">No active conversations</p>'
        return
      }
      const ul = document.createElement('ul')
      list.forEach(/** @param {{id:string,count:number}} c */ (c) => {
        const li = document.createElement('li')
        const left = document.createElement('div')
        left.style.display = 'flex'
        left.style.alignItems = 'center'
        left.style.gap = '10px'
  const idSpan = document.createElement('span')
  idSpan.className = 'convo-id'
  if (c && 'name' in c && c['name']) {
    idSpan.textContent = `${c['name']} — ${c.id}`
  } else {
    idSpan.textContent = c.id
  }
        const badge = document.createElement('span')
        badge.className = 'badge'
        badge.title = 'Messages in memory'
        const dot = document.createElement('span')
        dot.className = 'dot'
        const count = document.createElement('span')
        count.textContent = `${c.count} messages`
        badge.appendChild(dot)
        badge.appendChild(count)
        left.appendChild(idSpan)
        left.appendChild(badge)

        const actions = document.createElement('div')
        actions.className = 'list-actions'
        const copyBtn = document.createElement('button')
        copyBtn.className = 'btn copy-btn'
        copyBtn.textContent = 'Copy ID'
        copyBtn.addEventListener('click', async ()=>{
          try {
            await navigator.clipboard.writeText(c.id)
          } catch (e) {
            console.warn('Clipboard not available', e)
          }
        })
        const btn = document.createElement('button')
        btn.textContent = 'Clear'
        btn.className = 'btn'
        btn.addEventListener('click', async ()=>{
          const confirmed = confirm(`Clear memory for\n${c.id}?`)
          if (!confirmed) return
          await clearConversation(c.id)
          await fetchConversations()
        })
        actions.appendChild(copyBtn)
        actions.appendChild(btn)

        li.appendChild(left)
        li.appendChild(actions)
        ul.appendChild(li)
      })
      container.appendChild(ul)
    }catch(e){
      console.error('Unable to load conversations', e)
    }
  }

  /** @param {string} id */
  async function clearConversation(id){
    try{
      const r = await fetch('/admin/clear', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ chatId: id })
      })
      return r.ok
    }catch(e){
      console.error('Clear failed', e)
      return false
    }
  }

  const clearAll = document.getElementById('clearAll')
  if(clearAll) clearAll.addEventListener('click', async ()=>{
    const confirmed = confirm('Clear ALL conversation memories? This cannot be undone.')
    if (!confirmed) return
    await clearConversation('all')
    await fetchConversations()
  })

  fetchConversations()

  // Helper: show error for a field id
  /** @param {string} fieldId @param {string} msg */
  function showError(fieldId, msg){
    const el = document.getElementById(fieldId)
    if (!el) return
    const err = document.getElementById('err-'+fieldId)
    if (err) err.textContent = msg
    el.classList && el.classList.add('invalid')
  }
  /** Clear all field errors */
  function clearErrors(){
    ['botName','adminNumbers','systemPrompt','rateLimitMaxRequests','rateLimitWindowMs'].forEach(id => {
      const err = document.getElementById('err-'+id)
      if (err) err.textContent = ''
      const el = document.getElementById(id)
      if (el) el.classList && el.classList.remove('invalid')
    })
  }
  /** @returns {boolean} */
  function validateForm(){
    let ok = true
    const botName = (getInput('botName') || { value: '' }).value.trim()
    if (!botName) { showError('botName', 'Bot name is required'); ok = false }
    const sys = (getInput('systemPrompt') || { value: '' }).value.trim()
    if (!sys) { showError('systemPrompt', 'System prompt is required'); ok = false }
    const maxReq = Number((getInput('rateLimitMaxRequests') || { value: '0' }).value)
    if (!Number.isFinite(maxReq) || maxReq < 1) { showError('rateLimitMaxRequests', 'Must be 1 or more'); ok = false }
    const windowMs = Number((getInput('rateLimitWindowMs') || { value: '0' }).value)
    if (!Number.isFinite(windowMs) || windowMs < 1000) { showError('rateLimitWindowMs', 'Must be at least 1000 ms'); ok = false }
    const adminNumbers = (getInput('adminNumbers') || { value: '' }).value.trim()
    if (adminNumbers) {
      const re = /^[0-9]+(,\s*[0-9]+)*$/
      if (!re.test(adminNumbers)) { showError('adminNumbers', 'Admin numbers must be comma separated digits'); ok = false }
    }
    return ok
  }
})();
