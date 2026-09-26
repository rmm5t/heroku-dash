import blessed from 'blessed'
import {spawn} from 'node:child_process'
import {errorMessage} from '../api.js'
import {appRows, clean, single, sortApps, STAGES, TABS} from './views.js'
import {badge, icons, paint, palette, rowLabel, shortcut, stageStyles, tabIcons} from './theme.js'

const frame = () => ({border: {type: 'line'}, style: {fg: palette.fg, bg: palette.bg, border: {fg: palette.border}, focus: {border: {fg: palette.accent}}}})

export class Dashboard {
  constructor({api, catalog, context, refresh = 30, demo = false, screen}) {
    Object.assign(this, {api, catalog, context, refresh, demo})
    this.screen = screen ?? blessed.screen({smartCSR: true, fullUnicode: true, title: 'heroku dash', dockBorders: true, autoPadding: true})
    this.tab = 0
    this.mode = 'pipelines'
    this.team = context.team ?? null
    this.pipeline = context.pipeline ?? null
    this.app = null
    this.rows = []
    this.navItems = []
    this.generation = 0
    this.navGeneration = 0
    this.config = null
    this.revealed = null
    this.busy = false
    this.closed = false
    this.filter = ''
    this.message = context.reason
    this.messageTone = 'muted'
    this.widgets()
    this.bindings()
  }

  widgets() {
    const parent = this.screen
    this.header = blessed.box({parent, top: 0, height: 3, left: 0, right: 0, padding: {left: 2}, tags: false, style: {fg: palette.fg, bg: palette.panel}})
    this.nav = blessed.list({parent, top: 3, bottom: 4, left: 0, width: '28%', ...frame(), label: ` ${icons.pipelines}  Pipelines `, keys: true, vi: true, mouse: true, tags: false,
      scrollbar: {ch: '│', style: {bg: palette.border}}, style: {...frame().style, selected: {bg: palette.selected, fg: 'white', bold: true}, item: {fg: palette.fg}}})
    this.tabs = blessed.box({parent, top: 3, height: 3, left: '28%', right: 0, ...frame(), padding: {left: 1}, style: {...frame().style, fg: palette.accent}})
    this.summary = blessed.box({parent, top: 6, height: 5, left: '28%', right: 0, padding: {left: 2, right: 1}, style: {fg: palette.fg, bg: palette.bg}})
    this.main = blessed.list({parent, top: 11, height: '40%-4', left: '28%', right: 0, ...frame(), label: ` ${icons.apps}  Apps `, keys: true, vi: true, mouse: true, tags: false,
      scrollbar: {ch: '│', style: {bg: palette.border}}, style: {...frame().style, selected: {bg: palette.selected, fg: 'white'}, item: {fg: palette.fg}}})
    this.detail = blessed.box({parent, top: '40%+7', bottom: 4, left: '28%', right: 0, ...frame(), label: ` ${icons.overview}  Details `, padding: {left: 1, right: 1}, scrollable: true, alwaysScroll: true, keys: true, vi: true, mouse: true, tags: false,
      scrollbar: {ch: '│', style: {bg: palette.border}}})
    this.status = blessed.box({parent, bottom: 2, height: 2, left: 0, right: 0, padding: {left: 1}, tags: false, style: {fg: palette.muted, bg: palette.bg}})
    this.footer = blessed.box({parent, bottom: 0, height: 2, left: 0, right: 0, padding: {left: 1}, tags: false, style: {fg: palette.fg, bg: palette.panel},
      content: `${[['t', 'teams'], ['p', 'pipelines'], ['a', 'apps'], ['/', 'filter'], ['Enter', 'open'], ['Esc', 'back'], ['Tab', 'focus']].map(([key, text]) => shortcut(key, text)).join('  ')}\n${[['j/k', 'move'], ['1–7 / [ ]', 'views'], ['R', 'refresh'], ['o', 'browser'], ['?', 'help'], ['q', 'quit']].map(([key, text]) => shortcut(key, text)).join('  ')}`})
    this.small = blessed.box({parent, top: 0, left: 0, right: 0, bottom: 0, hidden: true, style: {fg: palette.fg, bg: palette.bg}, valign: 'middle', align: 'center', content: 'heroku dash\n\nPlease resize your terminal to at least 80 × 24.\n\nq / Ctrl-C to quit'})
    this.screen.on('resize', () => this.render())
    this.main.on('select item', () => {
      if (this.revealed && this.rows[this.main.selected]?.key !== this.revealed) {
        this.revealed = null
        this.drawApp()
      }
      this.drawDetail()
    })
    this.main.on('select', item => {
      if (this.modal) return
      const selected = this.rows[this.main.getItemIndex(item)]
      if (selected?.kind === 'app') void this.openApp(selected.value)
    })
    this.nav.on('select', item => {
      if (this.modal) return
      const selected = this.navItems[this.nav.getItemIndex(item)]
      if (selected) void this.navigate(selected)
    })
    this.nav.focus()
  }

  bindings() {
    const key = (keys, action) => this.screen.key(keys, (...args) => {
      if (!this.modal && !this.closed) action(...args)
    })
    this.screen.key(['C-c'], () => this.close())
    this.screen.key(['C-l'], () => { this.screen.realloc(); this.render() })
    key(['q'], () => this.close())
    key(['tab'], () => {
      const panes = [this.nav, this.main, this.detail]
      panes[(panes.indexOf(this.screen.focused) + 1) % panes.length].focus()
      this.render()
    })
    key(['S-tab'], () => {
      const panes = [this.nav, this.main, this.detail]
      panes[(panes.indexOf(this.screen.focused) + 2) % panes.length].focus()
      this.render()
    })
    key(['t'], () => this.setMode('teams'))
    key(['p'], () => this.setMode('pipelines'))
    key(['a'], () => this.setMode('apps'))
    key(['/'], () => void this.filterNav())
    key(['escape'], () => void this.back())
    key(['R'], () => void this.reload())
    key(['[', 'left'], () => this.changeTab((this.tab + TABS.length - 1) % TABS.length))
    key([']', 'right'], () => this.changeTab((this.tab + 1) % TABS.length))
    for (let i = 0; i < TABS.length; i++) key([String(i + 1)], () => this.changeTab(i))
    key(['v'], () => {
      const selected = this.rows[this.main.selected]
      if (this.app && TABS[this.tab] === 'Config' && selected?.kind === 'config') {
        this.revealed = this.revealed === selected.key ? null : selected.key
        this.drawApp()
      }
    })
    key(['s'], () => void this.scale())
    key(['e'], () => void this.editConfig(false))
    key(['n'], () => void this.editConfig(true))
    key(['d'], () => void this.deleteConfig())
    key(['m'], () => void this.maintenance())
    key(['o'], () => this.openBrowser())
    key(['?'], () => this.help())
  }

  async start() {
    if (this.context.team) this.mode = 'pipelines'
    this.drawNav()
    if (this.context.app) await this.openApp(this.context.app)
    else if (this.pipeline) await this.openPipeline(this.pipeline)
    else this.drawLanding()
    const warnings = [...this.catalog.warnings, ...this.context.warnings ?? []]
    if (warnings.length) this.setStatus(warnings.join(' | '), 'warning')
    if (this.refresh && !this.closed) this.timer = setInterval(() => {
      if (this.app && !this.modal && !this.busy && !this.closed) void this.loadApp(true)
    }, this.refresh * 1000)
    this.render()
  }

  setStatus(message, tone = 'info') { this.message = single(message); this.messageTone = tone; this.render() }

  render() {
    if (this.closed) return
    const scope = [['teams', this.team?.name], ['pipelines', this.pipeline?.name], ['apps', this.app?.name]]
      .filter(([, name]) => name).map(([icon, name]) => badge(icon, name, 'fg')).join(`  ${paint(icons.chevron, 'muted')}  `)
    this.header.setContent(`${paint(`${icons.heroku}  HEROKU DASH`, 'accent', true)}   ${this.demo ? `${badge('staging', 'DEMO', 'info')}   ` : ''}${this.api.readOnly ? badge('lock', 'READ ONLY', 'info') : badge('globe', 'LIVE', 'success')}\n${scope || badge('globe', 'All accessible resources', 'muted')}`)
    const tabs = compact => TABS.map((tab, i) => paint(i === this.tab ? `[${i + 1} ${icons[tabIcons[i]]} ${tab}]` : `${i + 1} ${icons[tabIcons[i]]}${compact ? '' : ` ${tab}`}`, i === this.tab ? 'accent' : 'muted', i === this.tab)).join('  ')
    const fullTabs = tabs(false)
    const compact = blessed.unicode.strWidth(clean(fullTabs)) > this.tabs.width - 4
    this.tabs.setContent(this.app ? compact ? tabs(true) : fullTabs : `${badge('pipelines', 'PIPELINE WORKSPACE')}  ${paint('· Enter an app', 'muted')}`)
    const statusIcon = {error: 'error', warning: 'warning', success: 'success', info: 'overview', muted: 'clock'}[this.messageTone]
    this.status.setContent(`${this.busy ? `${badge('refresh', 'Loading…', 'info')}  ` : ''}${badge(statusIcon, this.message ?? '', this.messageTone)}`)
    if (this.screen.width < 80 || this.screen.height < 24) { this.small.show(); this.small.setFront() }
    else this.small.hide()
    this.screen.render()
  }

  setMode(mode) {
    this.mode = mode
    this.filter = ''
    this.drawNav()
    this.nav.focus()
    this.render()
  }

  drawNav() {
    let items
    if (this.mode === 'teams') items = [{name: 'All teams / personal', id: null}, ...this.catalog.teams]
    else if (this.mode === 'pipelines') items = this.catalog.pipelines.filter(p => !this.team || p.owner?.id === this.team.id)
    else items = this.catalog.apps.filter(a => !this.team || a.team?.id === this.team.id || a.team?.name === this.team.name)
    this.navItems = items.filter(item => item.name.toLowerCase().includes(this.filter.toLowerCase()))
    this.nav.setLabel(` ${icons[this.mode]}  ${this.mode.toUpperCase()}${this.filter ? ` ${icons.search} ${single(this.filter)}` : ''} `)
    const tone = {teams: 'info', pipelines: 'accent', apps: 'cyan'}[this.mode]
    this.nav.setItems(this.navItems.length ? this.navItems.map(item => rowLabel({label: item.name, icon: item.id ? this.mode : 'globe', tone})) : [rowLabel({label: 'No matching items', icon: 'search', tone: 'muted'})])
    const id = this.mode === 'pipelines' ? this.pipeline?.id : this.mode === 'apps' ? this.app?.id : this.team?.id
    const index = this.navItems.findIndex(item => item.id === id)
    this.nav.select(Math.max(0, index))
    this.render()
  }

  async navigate(selected) {
    if (this.mode === 'teams') {
      this.team = selected.id ? selected : null
      this.pipeline = null
      this.clearApp()
      this.mode = 'pipelines'
      this.filter = ''
      this.drawNav()
      this.drawLanding()
      this.setStatus(`Browsing ${this.team?.name ?? 'all teams and personal apps'}. Press a for apps.`)
    } else if (this.mode === 'pipelines') await this.openPipeline(selected)
    else {
      this.pipeline = null
      await this.openApp(selected)
    }
  }

  clearApp() {
    this.generation++
    this.app = null
    this.data = null
    this.config = null
    this.configError = null
    this.revealed = null
    this.busy = false
  }

  drawLanding() {
    this.summary.setContent(`${badge('heroku', 'Your Heroku workspace')}\n\n${paint('Browse teams, pipelines, and apps with t / p / a. Select an item and press Enter.', 'muted')}`)
    this.main.setLabel(` ${icons.heroku}  Welcome `)
    this.setRows([{icon: 'pipelines', label: 'Choose a pipeline or app in the sidebar', detail: 'Navigation\n\nTab cycles between sidebar, list, and details.\nj/k or arrow keys move through lists.\n/ filters the sidebar.\n? displays all shortcuts.\n\nUse --app, --pipeline, --remote, or --team to choose a starting context.'}])
  }

  async openPipeline(pipeline) {
    this.clearApp()
    this.pipeline = pipeline
    const generation = this.generation
    this.busy = true
    this.summary.setContent(`${badge('pipelines', pipeline.name)}\n\n${badge('refresh', 'Loading pipeline apps…', 'info')}`)
    this.main.setLabel(` ${icons.apps}  Pipeline apps `)
    this.setRows([])
    try {
      const apps = sortApps(await this.api.pipelineApps(pipeline.id))
      if (this.closed || generation !== this.generation) return
      this.pipelineApps = apps
      this.summary.setContent(`${badge('pipelines', pipeline.name)}\n\n${STAGES.map(stage => badge(stageStyles[stage].icon, `${stage}: ${apps.filter(a => a.stage === stage).length}`, stageStyles[stage].tone)).join('   ')}`)
      this.setRows(apps.length ? apps.map(app => ({kind: 'app', value: app, ...stageStyles[app.stage], emphasis: app.stage.toUpperCase(),
        label: `${app.stage.toUpperCase().padEnd(13)} ${single(app.name)}  ·  ${app.region?.name ?? '—'}`,
        detail: `${single(app.name)}\n\nStage: ${app.stage}\nTeam: ${single(app.team?.name ?? 'Personal / shared')}\nRegion: ${single(app.region?.name)}\nStack: ${single(app.stack?.name)}\n\nEnter to view resources, add-ons, config, settings, releases, and metrics.`,
      })) : [{icon: 'apps', tone: 'muted', label: 'This pipeline has no apps', detail: 'Press a to browse accessible apps.'}])
      this.main.focus()
      this.message = 'Pipeline loaded. Select an app and press Enter.'
      this.messageTone = 'success'
    } catch (error) {
      if (generation === this.generation) {
        this.setRows([{icon: 'error', tone: 'error', label: 'Unable to load pipeline', detail: errorMessage(error)}])
        this.message = errorMessage(error)
        this.messageTone = 'error'
      }
    } finally {
      if (generation === this.generation) { this.busy = false; this.render() }
    }
  }

  async openApp(app) {
    this.clearApp()
    this.app = app
    this.tab = 0
    this.summary.setContent(`${badge('apps', app.name, 'cyan')}\n\n${badge('refresh', 'Loading app data…', 'info')}`)
    this.setRows([])
    this.main.focus()
    await this.loadApp()
  }

  async loadApp(automatic = false) {
    if (!this.app || this.busy || this.closed) return false
    const generation = this.generation
    const app = this.app
    this.busy = true
    this.render()
    try {
      const data = await this.api.appData(app.id)
      if (this.closed || generation !== this.generation) return
      this.data = data
      this.app = data.app
      this.message = `${automatic ? 'Auto-refreshed' : 'Updated'} ${new Date(data.fetchedAt).toLocaleTimeString()}${Object.keys(data.errors).length ? ' · Some sections unavailable; see Overview.' : ''}`
      this.messageTone = Object.keys(data.errors).length ? 'warning' : 'success'
      this.drawApp()
      return true
    } catch (error) {
      if (generation === this.generation) {
        this.message = `${errorMessage(error)}${this.data ? ' · Showing previous snapshot.' : ''}`
        this.messageTone = 'error'
        if (!this.data) this.setRows([{icon: 'error', tone: 'error', label: 'Unable to load app', detail: errorMessage(error)}])
      }
      return false
    } finally {
      if (generation === this.generation) { this.busy = false; this.render() }
    }
  }

  drawApp() {
    if (!this.data) return
    const {app, formation, errors} = this.data
    this.summary.setContent(`${badge('apps', app.name, 'cyan')}   ${app.maintenance ? badge('warning', 'MAINTENANCE', 'warning') : badge('success', 'ACTIVE', 'success')}\n${badge('teams', app.team?.name ?? 'Personal / shared', 'muted')}  ·  ${badge('globe', app.region?.name, 'info')}  ·  ${badge('stack', app.stack?.name, 'muted')}\n${badge('resources', errors.formation ? 'Dynos unavailable' : `${formation.reduce((sum, f) => sum + f.quantity, 0)} configured dynos`, errors.formation ? 'warning' : 'fg')}  ·  ${badge('addons', `${this.data.addons.length} add-ons`, 'fg')}  ·  ${badge('refresh', this.refresh ? `refresh ${this.refresh}s` : 'manual refresh', 'muted')}`)
    this.main.setLabel(` ${icons[tabIcons[this.tab]]}  ${TABS[this.tab]} `)
    this.setRows(appRows(TABS[this.tab], this.data, {config: this.config, configError: this.configError, revealed: this.revealed}), true)
  }

  setRows(rows, preserve = false) {
    const selected = preserve ? this.main.selected : 0
    this.rows = rows
    this.main.setItems(rows.map(rowLabel))
    this.main.select(Math.min(selected, Math.max(0, rows.length - 1)))
    this.drawDetail()
  }

  drawDetail() {
    const row = this.rows[this.main.selected]
    this.detail.setLabel(` ${icons[row?.icon] ?? icons.overview}  Details `)
    this.detail.setContent(clean(row?.detail ?? ''))
    this.detail.setScroll(0)
    this.render()
  }

  changeTab(index) {
    if (!this.app) return
    this.tab = index
    this.revealed = null
    this.main.select(0)
    this.drawApp()
    if (TABS[index] === 'Config' && !this.config) void this.loadConfig()
  }

  async loadConfig() {
    if (!this.app || this.closed) return
    const generation = this.generation
    const sequence = this.configSequence = (this.configSequence ?? 0) + 1
    try {
      const config = await this.api.config(this.app.id)
      if (this.closed || generation !== this.generation || sequence !== this.configSequence) return
      this.config = config
      this.configError = null
    } catch (error) {
      if (generation !== this.generation || sequence !== this.configSequence) return
      this.configError = errorMessage(error)
    }
    this.drawApp()
  }

  async back() {
    if (this.app && this.pipeline) await this.openPipeline(this.pipeline)
    else if (this.app || this.pipeline) {
      this.clearApp()
      this.pipeline = null
      this.drawLanding()
      this.nav.focus()
    } else {
      this.filter = ''
      this.drawNav()
      this.nav.focus()
    }
    this.render()
  }

  async reload() {
    if (this.busy) return
    if (this.app) {
      this.revealed = null
      await this.loadApp()
      if (TABS[this.tab] === 'Config') await this.loadConfig()
    } else if (this.pipeline) await this.openPipeline(this.pipeline)
    else {
      const sequence = ++this.navGeneration
      this.setStatus('Refreshing teams, pipelines, and apps…')
      try {
        const catalog = await this.api.catalog()
        if (this.closed || sequence !== this.navGeneration) return
        this.catalog = catalog
        this.drawNav()
        this.setStatus(catalog.warnings.join(' | ') || 'Workspace refreshed.', catalog.warnings.length ? 'warning' : 'success')
      } catch (error) { this.setStatus(errorMessage(error), 'error') }
    }
  }

  async filterNav() {
    const query = await this.prompt(`Filter ${this.mode}`, 'Filter the sidebar by name. Leave blank to clear.', this.filter)
    if (query === null) return
    this.filter = query
    this.drawNav()
    this.nav.focus()
    this.render()
  }

  prompt(title, description, initial = '', {secret = false, tone = 'accent', icon = 'keyboard'} = {}) {
    if (this.closed) return Promise.resolve(null)
    return new Promise(resolve => {
      const previous = this.screen.focused
      const modal = blessed.box({parent: this.screen, top: 'center', left: 'center', width: '85%', height: 14, ...frame(), label: ` ${icons[secret ? 'lock' : icon]}  ${single(title)} `, style: {...frame().style, border: {fg: palette[tone]}}})
      this.modal = modal
      blessed.box({parent: modal, top: 1, left: 2, right: 2, height: 6, content: clean(description), tags: false, style: {fg: palette.fg, bg: palette.bg}})
      const input = blessed.textbox({parent: modal, top: 8, left: 2, right: 2, height: 3, ...frame(), inputOnFocus: true, censor: secret, value: initial})
      blessed.text({parent: modal, bottom: 0, left: 2, content: `${shortcut('Enter', 'continue')}   ${shortcut('Esc', 'cancel')}   ${shortcut('Ctrl-U', 'clear')}`, style: {bg: palette.bg}})
      let finished = false
      const finish = value => {
        if (finished) return
        finished = true
        this.cancelPrompt = null
        input.clearValue()
        modal.destroy()
        this.modal = null
        if (!this.closed) { previous?.focus(); this.render() }
        resolve(value)
      }
      this.cancelPrompt = () => finish(null)
      input.on('submit', value => finish(value))
      input.on('cancel', () => finish(null))
      input.key(['C-c'], () => this.close())
      input.key(['C-u'], () => { input.clearValue(); this.render() })
      input.focus()
      this.render()
    })
  }

  writable() {
    if (this.api.readOnly) { this.setStatus('Read-only mode: remote changes are disabled.', 'warning'); return false }
    if (!this.app || !this.data || this.busy) return false
    return true
  }

  async confirm(app, description) {
    const value = await this.prompt('Confirm remote change', `${description}\n\nTarget: ${app.name}\nType the exact app name to apply this change.`, '', {icon: 'warning', tone: 'warning'})
    if (value === null) { this.setStatus('Change cancelled.'); return null }
    if (value !== app.name) { this.setStatus('App name did not match. Nothing changed.', 'warning'); return null }
    return value
  }

  async mutate(action) {
    // Lock navigation while a confirmed write is in flight. Its target and the
    // subsequent refresh must remain the app named in the confirmation.
    const modal = blessed.box({parent: this.screen, top: 'center', left: 'center', width: '70%', height: 5, ...frame(),
      content: `\n  ${badge('refresh', 'Applying confirmed change…', 'info')}`})
    this.modal = modal
    this.busy = true
    this.setStatus('Applying change…')
    try {
      await action()
      if (this.closed) return
      this.busy = false
      this.config = null
      this.revealed = null
      const refreshed = await this.loadApp()
      if (TABS[this.tab] === 'Config') await this.loadConfig()
      this.setStatus(refreshed ? 'Change applied. App data refreshed.' : `Change applied, but refresh failed. ${this.message}`, refreshed ? 'success' : 'warning')
    } catch (error) { this.setStatus(errorMessage(error), 'error') }
    finally { modal.destroy(); this.modal = null; this.busy = false; this.render() }
  }

  async scale() {
    if (TABS[this.tab] !== 'Resources' || !this.writable()) return
    const row = this.rows[this.main.selected]
    if (row?.kind !== 'formation') { this.setStatus(`Select a process type (${icons.resources}) to scale.`); return }
    const app = this.app
    const formation = row.value
    const quantity = await this.prompt('Scale dynos · quantity', `${app.name} / ${formation.type}\nCurrent: ${formation.quantity} × ${formation.size}\nEnter desired quantity (0 stops this process).`, String(formation.quantity))
    if (quantity === null) return
    if (!/^\d+$/.test(quantity) || !Number.isSafeInteger(Number(quantity))) { this.setStatus('Quantity must be a non-negative integer.', 'warning'); return }
    const size = await this.prompt('Scale dynos · size', `${app.name} / ${formation.type}\nEnter a Heroku dyno size (for example Standard-1X).`, formation.size)
    if (size === null) return
    if (!size.trim()) { this.setStatus('Dyno size cannot be blank.', 'warning'); return }
    const confirmation = await this.confirm(app, `Scale ${formation.type}: ${formation.quantity} × ${formation.size} → ${quantity} × ${size.trim()}.\nThis can restart dynos and change billing.`)
    if (confirmation) await this.mutate(() => this.api.scale(app.name, formation.type, Number(quantity), size, confirmation))
  }

  async editConfig(isNew) {
    if (TABS[this.tab] !== 'Config' || !this.writable() || !this.config) return
    const app = this.app
    let key = this.rows[this.main.selected]?.key
    if (isNew) key = await this.prompt('New config variable', `${app.name}\nEnter the variable name.`)
    if (!key) return
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) { this.setStatus('Invalid config variable name.', 'warning'); return }
    const value = await this.prompt('Config variable · value', `${app.name} / ${key}\nEnter a new single-line value (input is masked; blank is an empty string).`, '', {secret: true})
    if (value === null) return
    const confirmation = await this.confirm(app, `${Object.hasOwn(this.config, key) ? 'Replace' : 'Create'} config variable ${key}.\nThis creates a release and restarts the app.`)
    if (confirmation) await this.mutate(() => this.api.setConfig(app.name, key, value, confirmation))
  }

  async deleteConfig() {
    if (TABS[this.tab] !== 'Config' || !this.writable()) return
    const key = this.rows[this.main.selected]?.key
    if (!key) return
    const app = this.app
    const confirmation = await this.confirm(app, `Delete config variable ${key}.\nThis creates a release and restarts the app.`)
    if (confirmation) await this.mutate(() => this.api.setConfig(app.name, key, null, confirmation))
  }

  async maintenance() {
    if (TABS[this.tab] !== 'Settings' || !this.writable()) return
    const app = this.app
    const enabled = !app.maintenance
    const confirmation = await this.confirm(app, `${enabled ? 'Enable' : 'Disable'} maintenance mode.\n${enabled ? 'The app will serve the maintenance page.' : 'The app will resume serving requests.'}`)
    if (confirmation) await this.mutate(() => this.api.maintenance(app.name, enabled, confirmation))
  }

  openBrowser() {
    if (this.demo) { this.setStatus('Browser links are disabled in the offline demo.'); return }
    let url
    if (this.app) {
      const path = ['activity', 'resources', 'resources', 'settings', 'settings', 'activity', 'metrics'][this.tab]
      url = `https://dashboard.heroku.com/apps/${encodeURIComponent(this.app.name)}/${path}`
    } else if (this.pipeline) url = `https://dashboard.heroku.com/pipelines/${encodeURIComponent(this.pipeline.id)}`
    else if (this.team) url = `https://dashboard.heroku.com/teams/${encodeURIComponent(this.team.name)}/apps`
    else url = 'https://dashboard.heroku.com/apps'
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open'
    const child = spawn(command, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url], {stdio: 'ignore'})
    child.on('error', error => this.setStatus(`Unable to open browser: ${error.message}`, 'error'))
    child.on('exit', code => this.setStatus(code === 0 ? 'Opened Heroku dashboard in your browser.' : `Browser exited with code ${code}.`, code === 0 ? 'success' : 'error'))
  }

  help() {
    const previous = this.screen.focused
    const modal = blessed.box({parent: this.screen, top: 'center', left: 'center', width: '85%', height: '85%', ...frame(), label: ` ${icons.keyboard}  Keyboard shortcuts `, padding: {left: 2, top: 1}, scrollable: true, keys: true, vi: true,
      content: 'NAVIGATION\n  t / p / a       Browse teams / pipelines / apps\n  j / k, ↑ / ↓    Move selection or scroll details\n  Enter           Open selected team, pipeline, or app\n  Tab / Shift-Tab Focus next / previous pane\n  /               Filter sidebar by name\n  Esc             Return to pipeline / workspace; clear filter\n  1–7             Select app view\n  [ / ], ← / →    Previous / next app view\n  R               Refresh current app, pipeline, or workspace\n  o               Open current view in web dashboard\n  q / Ctrl-C      Quit\n\nAPP ACTIONS\n  s               Scale selected Resources process type\n  v               Reveal / hide selected config variable\n  e / n / d       Replace / create / delete config variable\n  m               Toggle maintenance in Settings\n\nRemote changes require typing the exact target app name.\n--read-only disables every mutation at the API boundary.\nConfig values are masked and fetched only on opening Config.\nLeaving the tab or app hides revealed values.\n\nMetrics show dyno health and recent deployment outcomes.\nMemory / CPU / latency charts require the web dashboard.\n\nPress Esc, ?, or q to close help.'})
    this.modal = modal
    modal.key(['escape', '?', 'q'], () => { modal.destroy(); this.modal = null; previous?.focus(); this.render() })
    modal.focus()
    this.render()
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    this.generation++
    this.cancelPrompt?.()
    this.config = null
    this.screen.destroy()
  }
}

export async function runDashboard(options) {
  const dashboard = new Dashboard(options)
  const finished = new Promise(resolve => dashboard.screen.once('destroy', resolve))
  const stop = () => dashboard.close()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    await dashboard.start()
    await finished
  } finally {
    dashboard.close()
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
  }
}
