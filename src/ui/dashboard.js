import blessed from 'blessed'
import clipboard from 'clipboardy'
import {spawn} from 'node:child_process'
import {errorMessage} from '../api.js'
import {resolveHierarchy} from '../hierarchy.js'
import {fetchTelemetry, metricsScope} from '../metrics.js'
import {appRows, clean, single, sortApps, STAGES, TABS} from './views.js'
import {detailContent, isValueClick} from './details.js'
import {tableColumns} from './columns.js'
import {badge, icons, paint, palette, rowLabel, SCANNER_INTERVAL, scannerFrame, shortcut, stageStyles, styleListSelection, tabIcons} from './theme.js'

const SIDEBAR_WIDTH = '22%'
const frame = () => ({border: {type: 'line'}, style: {fg: palette.fg, bg: palette.bg, border: {fg: palette.border}, focus: {border: {fg: palette.accent}}}})

export class Dashboard {
  constructor({api, catalog, context, resources = null, refresh = 30, demo = false, screen, writeClipboard = clipboard.write,
    fetchMetrics = (data, options) => fetchTelemetry(api, data, options)}) {
    Object.assign(this, {api, catalog, context, resources, refresh, demo, writeClipboard, fetchMetrics})
    this.screen = screen ?? blessed.screen({smartCSR: true, fullUnicode: true, title: 'heroku dash', dockBorders: true, autoPadding: true})
    this.tab = 0
    this.mode = 'pipelines'
    this.team = context.team ?? null
    this.breadcrumbTeam = null
    this.pipeline = context.pipeline ?? null
    this.app = null
    this.rows = []
    this.updatingRows = false
    this.navItems = []
    this.generation = 0
    this.navGeneration = 0
    this.config = null
    this.resourceData = {}
    this.resourceErrors = {}
    this.resourceRequests = new Map()
    this.telemetry = null
    this.metricsError = null
    this.metricsRequest = null
    this.metricsSignature = null
    this.metricsRequestedAt = 0
    this.revealed = new Set()
    this.copying = false
    this.busy = false
    this.loading = new Map()
    this.loadingFrame = 0
    this.loadingTimer = null
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
    this.nav = blessed.list({parent, top: 3, bottom: 4, left: 0, width: SIDEBAR_WIDTH, ...frame(), label: ` ${icons.pipelines}  Pipelines `, keys: true, mouse: true, tags: false,
      scrollbar: {ch: '│', style: {bg: palette.border}}, style: {...frame().style, selected: {bold: true}, item: {fg: palette.fg}}})
    this.tabs = blessed.box({parent, top: 3, height: 3, left: SIDEBAR_WIDTH, right: 0, ...frame(), padding: {left: 1}, style: {...frame().style, fg: palette.accent}})
    this.summary = blessed.box({parent, top: 6, height: 5, left: SIDEBAR_WIDTH, right: 0, padding: {left: 2, right: 1}, style: {fg: palette.fg, bg: palette.bg}})
    this.main = blessed.list({parent, top: 11, height: '40%-4', left: SIDEBAR_WIDTH, right: 0, ...frame(), label: ` ${icons.apps}  Apps `, keys: true, mouse: true, tags: false,
      scrollbar: {ch: '│', style: {bg: palette.border}}, style: {...frame().style, item: {fg: palette.fg}}})
    for (const list of [this.nav, this.main]) styleListSelection(list)
    this.columnHeader = blessed.box({parent: this.main, top: -1, left: 0, right: 1, height: 1, fixed: true, hidden: true, tags: false, autoFocus: false,
      style: {fg: palette.muted, bg: palette.panel, bold: true}})
    this.columnHeader.on('click', () => {
      if (this.modal || this.closed) return
      this.main.focus()
      this.render()
    })
    this.detail = blessed.box({parent, top: '40%+7', bottom: 4, left: SIDEBAR_WIDTH, right: 0, ...frame(), label: ` ${icons.overview}  Details `, padding: {left: 1, right: 1}, scrollable: true, alwaysScroll: true, keys: true, vi: true, mouse: true, tags: false,
      scrollbar: {ch: '│', style: {bg: palette.border}}})
    this.status = blessed.box({parent, bottom: 2, height: 2, left: 0, right: 0, padding: {left: 1}, tags: false, style: {fg: palette.muted, bg: palette.bg}})
    this.footer = blessed.box({parent, bottom: 0, height: 2, left: 0, right: 0, padding: {left: 1}, tags: false, style: {fg: palette.fg, bg: palette.panel},
      content: `${[['t', 'teams'], ['p', 'pipelines'], ['a', 'apps'], ['/', 'filter'], ['Enter', 'open'], ['Esc', 'back'], ['Tab', 'focus']].map(([key, text]) => shortcut(key, text)).join('  ')}\n${[['j/k', 'move'], ['1–7 / [ ] / h l', 'views'], ['R/g', 'refresh'], ['o', 'browser'], ['?', 'help'], ['q', 'quit']].map(([key, text]) => shortcut(key, text)).join('  ')}`})
    this.small = blessed.box({parent, top: 0, left: 0, right: 0, bottom: 0, hidden: true, style: {fg: palette.fg, bg: palette.bg}, valign: 'middle', align: 'center', content: 'heroku dash\n\nPlease resize your terminal to at least 80 × 24.\n\nq / Ctrl-C to quit'})
    this.screen.on('resize', () => this.render())
    this.screen.once('destroy', () => this.close())
    this.main.on('select item', () => {
      if (this.updatingRows) return
      this.drawDetail()
    })
    this.main.on('select', item => {
      if (this.modal) return
      const selected = this.rows[this.main.getItemIndex(item)]
      if (selected?.kind === 'app') void this.openApp(selected.value, this.pipeline)
    })
    this.detail.on('click', mouse => {
      if (this.closed || this.modal || this.small.visible) return
      const row = this.rows[this.main.selected]
      if (this.revealed.has(row?.key) && isValueClick(this.detail, row, mouse)) void this.copyConfig()
    })
    this.nav.on('select', item => {
      if (this.modal) return
      const selected = this.navItems[this.nav.getItemIndex(item)]
      if (selected) void this.navigate(selected)
    })
    this.nav.focus()
  }

  bindings() {
    // Bind list movement explicitly: Blessed's vi mode also treats l as Enter,
    // which would open a sidebar item while switching to the next app view.
    for (const list of [this.nav, this.main]) {
      list.key(['j'], () => { list.down(); this.render() })
      list.key(['k'], () => { list.up(); this.render() })
    }
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
    key(['R', 'S-r', 'g'], () => void this.reload())
    key(['[', 'left', 'h'], () => this.changeTab((this.tab + TABS.length - 1) % TABS.length))
    key([']', 'right', 'l'], () => this.changeTab((this.tab + 1) % TABS.length))
    for (let i = 0; i < TABS.length; i++) key([String(i + 1)], () => this.changeTab(i))
    key(['v'], () => {
      const selected = this.rows[this.main.selected]
      if (this.app && TABS[this.tab] === 'Config' && selected?.kind === 'config') {
        if (this.revealed.has(selected.key)) this.revealed.delete(selected.key)
        else this.revealed.add(selected.key)
        this.drawApp()
      }
    })
    key(['s'], () => void this.scale())
    key(['y'], () => void this.copyConfig())
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
    if (this.context.app) await this.openApp(this.context.app, this.context.pipeline)
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

  beginLoading(key, label) {
    if (this.closed) return () => {}
    const operation = {label}
    this.loading.set(key, operation)
    this.syncLoadingAnimation()
    this.render()
    return () => {
      // A superseded request must not clear the indicator for its replacement.
      if (this.loading.get(key) !== operation) return
      this.loading.delete(key)
      this.syncLoadingAnimation()
      this.render()
    }
  }

  syncLoadingAnimation() {
    if (this.closed || !this.loading.size) {
      clearInterval(this.loadingTimer)
      this.loadingTimer = null
      this.loadingFrame = 0
    } else if (!this.loadingTimer) {
      this.loadingTimer = setInterval(() => {
        this.loadingFrame++
        // Redraw only the status content: don't reset list selection, scroll
        // position, or an input prompt while the user continues navigating.
        this.drawStatus()
        this.screen.render()
      }, SCANNER_INTERVAL)
      this.loadingTimer.unref()
    }
  }

  drawStatus() {
    const current = [...this.loading.values()].at(-1)
    if (current) {
      this.status.setContent(`${scannerFrame(this.loadingFrame)}  ${paint(single(current.label), 'info')}`)
    } else {
      const icon = {error: 'error', warning: 'warning', success: 'success', info: 'overview', muted: 'clock'}[this.messageTone]
      this.status.setContent(badge(icon, this.message ?? '', this.messageTone))
    }
  }

  render() {
    if (this.closed) return
    const metricView = this.app && TABS[this.tab] === 'Metrics'
    const listHeight = Math.max(5, Math.floor(this.screen.height * 0.32) - 4)
    this.main.height = metricView ? listHeight : '40%-4'
    this.detail.top = metricView ? 11 + listHeight : '40%+7'
    this.layoutColumns()
    this.layoutMetricChart()
    const team = this.app || this.pipeline ? this.breadcrumbTeam?.name ?? 'Loading team…' : this.team?.name
    const pipeline = this.pipeline?.name ?? (this.app ? this.data ? this.data.errors.coupling ? 'Pipeline unavailable' : 'No pipeline' : 'Loading pipeline…' : null)
    const scope = [['teams', team], ['pipelines', pipeline], ['apps', this.app?.name]]
      .filter(([, name]) => name).map(([icon, name]) => badge(icon, name, 'fg')).join(`  ${paint(icons.chevron, 'muted')}  `)
    this.header.setContent(`${paint(`${icons.heroku}  HEROKU DASH`, 'accent', true)}   ${this.demo ? `${badge('staging', 'DEMO', 'info')}   ` : ''}${this.api.readOnly ? badge('lock', 'READ ONLY', 'info') : badge('globe', 'READ / WRITE', 'success')}\n${scope || badge('globe', 'All accessible resources', 'muted')}`)
    const tabs = compact => TABS.map((tab, i) => paint(i === this.tab ? `[${i + 1} ${icons[tabIcons[i]]} ${tab}]` : `${i + 1} ${icons[tabIcons[i]]}${compact ? '' : ` ${tab}`}`, i === this.tab ? 'accent' : 'muted', i === this.tab)).join('  ')
    const fullTabs = tabs(false)
    const compact = blessed.unicode.strWidth(clean(fullTabs)) > this.tabs.width - 4
    this.tabs.setContent(this.app ? compact ? tabs(true) : fullTabs : `${badge('pipelines', 'PIPELINE WORKSPACE')}  ${paint('· Enter an app', 'muted')}`)
    this.drawStatus()
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
    else await this.openApp(selected)
  }

  clearApp() {
    this.generation++
    this.resetMetrics()
    this.resetResourceDetails()
    for (const key of ['app', 'pipeline', 'config']) this.loading.delete(key)
    this.syncLoadingAnimation()
    this.app = null
    this.breadcrumbTeam = null
    this.data = null
    this.config = null
    this.configError = null
    this.revealed.clear()
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
    const owner = pipeline.owner ?? this.catalog.pipelines.find(item => item.id === pipeline.id)?.owner
    this.breadcrumbTeam = owner?.type === 'team' ? this.catalog.teams.find(item => item.id === owner.id) ?? null : owner ? {name: 'Personal'} : null
    const generation = this.generation
    this.busy = true
    this.summary.setContent(`${badge('pipelines', pipeline.name)}\n\n${badge('refresh', 'Loading pipeline apps…', 'info')}`)
    this.main.setLabel(` ${icons.apps}  Pipeline apps `)
    this.setRows([])
    const finishLoading = this.beginLoading('pipeline', `Loading pipeline ${pipeline.name}…`)
    try {
      const [appsResult, hierarchy] = await Promise.all([
        this.api.pipelineApps(pipeline.id).then(apps => ({apps}), error => ({error})),
        resolveHierarchy(this.api, this.catalog, {pipeline}),
      ])
      if (this.closed || generation !== this.generation) return
      this.pipeline = hierarchy.pipeline
      this.breadcrumbTeam = hierarchy.team
      if (appsResult.error) throw appsResult.error
      const apps = sortApps(appsResult.apps)
      this.pipelineApps = apps
      this.summary.setContent(`${badge('pipelines', pipeline.name)}\n\n${STAGES.map(stage => badge(stageStyles[stage].icon, `${stage}: ${apps.filter(a => a.stage === stage).length}`, stageStyles[stage].tone)).join('   ')}`)
      this.setRows(apps.length ? apps.map(app => ({kind: 'app', value: app, ...stageStyles[app.stage], emphasis: app.stage.toUpperCase(),
        label: `${app.stage.toUpperCase().padEnd(13)} ${single(app.name)}  ·  ${app.region?.name ?? '—'}`,
        detail: `${single(app.name)}\n\nStage: ${app.stage}\nTeam: ${single(app.team?.name ?? 'Personal / shared')}\nRegion: ${single(app.region?.name)}\nStack: ${single(app.stack?.name)}\n\nEnter to view resources, add-ons, config, settings, releases, and metrics.`,
      })) : [{icon: 'apps', tone: 'muted', label: 'This pipeline has no apps', detail: 'Press a to browse accessible apps.'}])
      this.main.focus()
      this.message = `Pipeline loaded. Select an app and press Enter.${hierarchy.errors.hierarchy ? ` · ${hierarchy.errors.hierarchy}` : ''}`
      this.messageTone = hierarchy.errors.hierarchy ? 'warning' : 'success'
    } catch (error) {
      if (generation === this.generation) {
        this.setRows([{icon: 'error', tone: 'error', label: 'Unable to load pipeline', detail: errorMessage(error)}])
        this.message = errorMessage(error)
        this.messageTone = 'error'
      }
    } finally {
      if (generation === this.generation) { this.busy = false; this.render() }
      finishLoading()
    }
  }

  async openApp(app, pipeline = null) {
    this.clearApp()
    const generation = this.generation
    this.app = app
    this.pipeline = pipeline
    this.breadcrumbTeam = app.team ?? null
    this.summary.setContent(`${badge('apps', app.name, 'cyan')}\n\n${badge('refresh', 'Loading app data…', 'info')}`)
    this.main.setLabel(` ${icons[tabIcons[this.tab]]}  ${TABS[this.tab]} `)
    this.setRows([])
    this.main.focus()
    const loaded = await this.loadApp()
    if (loaded && !this.closed && generation === this.generation && TABS[this.tab] === 'Config' && !this.config && !this.loading.has('config')) {
      await this.loadConfig()
    }
  }

  async loadApp(automatic = false, {forceResources = false} = {}) {
    if (!this.app || this.busy || this.closed) return false
    const generation = this.generation
    const app = this.app
    this.busy = true
    const finishLoading = this.beginLoading('app', `${this.data ? 'Refreshing' : 'Loading'} app ${app.name}…`)
    try {
      const data = await this.api.appData(app.id)
      if (this.closed || generation !== this.generation) return
      const hierarchy = await resolveHierarchy(this.api, this.catalog, {app: data.app, pipeline: data.coupling?.pipeline})
      if (this.closed || generation !== this.generation) return
      this.pipeline = hierarchy.pipeline
      this.breadcrumbTeam = hierarchy.team
      Object.assign(data.errors, hierarchy.errors)
      this.resetResourceDetails()
      this.data = data
      this.app = data.app
      if (this.metricsSignature && this.metricsSignature !== metricsScope(data)) this.resetMetrics()
      this.message = `${automatic ? 'Auto-refreshed' : 'Updated'} ${new Date(data.fetchedAt).toLocaleTimeString()}${Object.keys(data.errors).length ? ' · Some sections unavailable; see Overview.' : ''}`
      this.messageTone = Object.keys(data.errors).length ? 'warning' : 'success'
      this.drawApp({preserveScroll: automatic && TABS[this.tab] === 'Metrics'})
      void this.loadResourceDetails({force: forceResources})
      void this.loadMetrics({refresh: true, force: !automatic})
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
      finishLoading()
    }
  }

  drawApp({preserveScroll = false} = {}) {
    if (!this.data) return
    const scroll = this.detail.childBase
    const {app, formation, errors} = this.data
    this.summary.setContent(`${badge('apps', app.name, 'cyan')}   ${app.maintenance ? badge('warning', 'MAINTENANCE', 'warning') : badge('success', 'ACTIVE', 'success')}\n${badge('teams', app.team?.name ?? 'Personal / shared', 'muted')}  ·  ${badge('globe', app.region?.name, 'info')}  ·  ${badge('stack', app.stack?.name, 'muted')}\n${badge('resources', errors.formation ? 'Dynos unavailable' : `${formation.reduce((sum, f) => sum + f.quantity, 0)} configured dynos`, errors.formation ? 'warning' : 'fg')}  ·  ${badge('addons', `${this.data.addons.length} add-ons`, 'fg')}  ·  ${badge('refresh', this.refresh ? `refresh ${this.refresh}s` : 'manual refresh', 'muted')}`)
    this.main.setLabel(` ${icons[tabIcons[this.tab]]}  ${TABS[this.tab]} `)
    this.setRows(appRows(TABS[this.tab], this.data, {
      config: this.config, configError: this.configError, revealed: this.revealed,
      resources: {provider: this.resources, data: this.resourceData, errors: this.resourceErrors},
      metrics: {snapshot: this.telemetry, error: this.metricsError},
    }), true)
    if (preserveScroll) { this.detail.setScroll(scroll); this.render() }
  }

  resetMetrics() {
    this.metricsRequest?.controller.abort()
    this.metricsRequest = null
    this.telemetry = null
    this.metricsError = null
    this.metricsSignature = null
    this.metricsRequestedAt = 0
    this.loading.delete('metrics')
    this.syncLoadingAnimation()
  }

  async loadMetrics({refresh = false, force = false} = {}) {
    if (TABS[this.tab] !== 'Metrics' || !this.data || this.closed) return
    const signature = metricsScope(this.data)
    if (this.metricsRequest && !force) return
    if (!force && !refresh && this.metricsSignature === signature && Date.now() - this.metricsRequestedAt < 30_000) return
    this.metricsRequest?.controller.abort()
    const request = {controller: new AbortController()}
    const generation = this.generation
    this.metricsRequest = request
    this.metricsSignature = signature
    this.metricsRequestedAt = Date.now()
    this.metricsError = null
    const current = () => !this.closed && generation === this.generation && this.metricsRequest === request && !request.controller.signal.aborted
    const finishLoading = this.beginLoading('metrics', 'Loading performance metrics…')
    try {
      const snapshot = await this.fetchMetrics(this.data, {signal: request.controller.signal})
      if (!current()) return
      this.telemetry = snapshot
    } catch (error) {
      if (current()) this.metricsError = errorMessage(error)
    } finally {
      if (current()) {
        this.metricsRequest = null
        if (TABS[this.tab] === 'Metrics') this.drawApp({preserveScroll: true})
      }
      finishLoading()
    }
  }

  resetResourceDetails() {
    this.resourceData = {}
    this.resourceErrors = {}
    this.resourceRequests.clear()
    for (const kind of ['dynos', 'addons']) this.loading.delete(`resources-${kind}`)
    this.syncLoadingAnimation()
  }

  async loadResourceDetails({force = false} = {}) {
    const kind = {Resources: 'dynos', 'Add-ons': 'addons'}[TABS[this.tab]]
    if (!kind || !this.resources?.available || !this.data || this.closed) return
    if (!force && (this.resourceData[kind] || this.resourceErrors[kind] || this.resourceRequests.has(kind))) return
    const data = this.data
    const generation = this.generation
    const request = {}
    this.resourceRequests.set(kind, request)
    const current = () => !this.closed && generation === this.generation && this.data === data && this.resourceRequests.get(kind) === request
    const finishLoading = this.beginLoading(`resources-${kind}`, `Loading ${kind === 'dynos' ? 'dyno costs and allocations' : 'add-on costs and limits'}…`)
    try {
      const result = await this.resources[kind](data, {force})
      if (!current()) return
      this.resourceData[kind] = result
      delete this.resourceErrors[kind]
    } catch (error) {
      if (!current()) return
      this.resourceErrors[kind] = errorMessage(error)
    } finally {
      if (current()) {
        this.resourceRequests.delete(kind)
        if ({Resources: 'dynos', 'Add-ons': 'addons'}[TABS[this.tab]] === kind) {
          // getScroll() includes Blessed's cursor offset; childBase is the
          // actual first visible line that should survive this redraw.
          const scroll = this.detail.childBase
          this.drawApp()
          this.detail.setScroll(scroll)
          this.render()
        }
      }
      finishLoading()
    }
  }

  setRows(rows, preserve = false) {
    const previous = this.rows[this.main.selected]
    const matching = preserve && previous?.id ? rows.findIndex(row => row.id === previous.id) : -1
    const selected = preserve ? matching >= 0 ? matching : this.main.selected : 0
    // Update existing items in place to preserve the viewport. Blessed's
    // setItems temporarily selects row zero, then scrolls back to the selection.
    // Suppress those synthetic selection events when a rebuild is needed.
    this.updatingRows = true
    try {
      this.rows = rows
      const labels = rows.map(row => rowLabel(row, this.main.width - this.main.iwidth - 1))
      if (preserve && labels.length === this.main.items.length) {
        for (const [index, label] of labels.entries()) this.main.setItem(index, label)
      } else this.main.setItems(labels)
      this.main.select(Math.min(selected, Math.max(0, rows.length - 1)))
    } finally {
      this.updatingRows = false
    }
    this.drawDetail()
  }

  layoutColumns() {
    const columnar = this.rows.find(row => row.columns)
    this.main.padding.top = columnar ? 1 : 0
    // Keep the border label above the new header padding (Blessed normally
    // repositions labels only after scrolling or resizing).
    if (this.main._label) this.main._label.rtop = this.main.childBase - this.main.itop
    if (!columnar) { this.columnHeader.hide(); return }
    const width = this.main.width - this.main.iwidth - 1
    this.columnHeader.setContent(`    ${tableColumns(null, width - 4, columnar.columnLayout)}`)
    this.columnHeader.show()
    this.columnHeader.setFront()
    // Reflow on resize without rebuilding the list or changing its selection.
    for (const [index, row] of this.rows.entries()) {
      const label = rowLabel(row, width)
      if (this.main.ritems[index] !== label) this.main.setItem(index, label)
    }
  }

  drawDetail() {
    const row = this.rows[this.main.selected]
    this.detail.setLabel(` ${icons[row?.icon] ?? icons.overview}  Details `)
    const dimensions = this.detailDimensions()
    this.detail.setContent(detailContent(row, dimensions))
    this.chartLayout = row?.metricChart ? {row, ...dimensions} : null
    this.detail.setScroll(0)
    this.render()
  }

  detailDimensions() {
    return {width: Math.max(1, this.detail.width - this.detail.iwidth - 1), height: this.detail.height - this.detail.iheight}
  }

  layoutMetricChart() {
    const row = this.rows[this.main.selected]
    if (!row?.metricChart) { this.chartLayout = null; return }
    const {width, height} = this.detailDimensions()
    if (this.chartLayout?.row === row && this.chartLayout.width === width && this.chartLayout.height === height) return
    const scroll = this.detail.childBase
    this.detail.setContent(detailContent(row, {width, height}))
    this.detail.setScroll(scroll)
    this.chartLayout = {row, width, height}
  }

  changeTab(index) {
    if (!this.app) return
    this.tab = index
    this.revealed.clear()
    this.main.select(0)
    this.drawApp()
    if (TABS[index] === 'Config' && !this.config) void this.loadConfig()
    void this.loadResourceDetails()
    void this.loadMetrics()
  }

  async loadConfig() {
    if (!this.app || this.closed) return
    const generation = this.generation
    const sequence = this.configSequence = (this.configSequence ?? 0) + 1
    const finishLoading = this.beginLoading('config', `Loading config vars for ${this.app.name}…`)
    try {
      const config = await this.api.config(this.app.id)
      if (this.closed || generation !== this.generation || sequence !== this.configSequence) return
      this.config = config
      this.configError = null
    } catch (error) {
      if (generation !== this.generation || sequence !== this.configSequence) return
      this.configError = errorMessage(error)
    } finally {
      finishLoading()
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
      this.revealed.clear()
      await this.loadApp(false, {forceResources: true})
      if (TABS[this.tab] === 'Config') await this.loadConfig()
    } else if (this.pipeline) await this.openPipeline(this.pipeline)
    else {
      const sequence = ++this.navGeneration
      this.setStatus('Refreshing teams, pipelines, and apps…')
      const finishLoading = this.beginLoading('catalog', 'Refreshing teams, pipelines, and apps…')
      try {
        const catalog = await this.api.catalog()
        if (this.closed || sequence !== this.navGeneration) return
        this.catalog = catalog
        this.drawNav()
        this.setStatus(catalog.warnings.join(' | ') || 'Workspace refreshed.', catalog.warnings.length ? 'warning' : 'success')
      } catch (error) { this.setStatus(errorMessage(error), 'error') }
      finally { finishLoading() }
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
    const finishLoading = this.beginLoading('mutation', 'Applying confirmed change…')
    try {
      await action()
      if (this.closed) return
      this.busy = false
      this.config = null
      this.revealed.clear()
      const refreshed = await this.loadApp()
      if (TABS[this.tab] === 'Config') await this.loadConfig()
      this.setStatus(refreshed ? 'Change applied. App data refreshed.' : `Change applied, but refresh failed. ${this.message}`, refreshed ? 'success' : 'warning')
    } catch (error) { this.setStatus(errorMessage(error), 'error') }
    finally { modal.destroy(); this.modal = null; this.busy = false; finishLoading(); this.render() }
  }

  async scale() {
    if (!['Overview', 'Resources'].includes(TABS[this.tab]) || !this.writable()) return
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

  async copyConfig() {
    if (TABS[this.tab] !== 'Config' || !this.app || !this.config || this.copying) return
    const row = this.rows[this.main.selected]
    if (row?.kind !== 'config' || typeof this.config[row.key] !== 'string') return
    const generation = this.generation
    this.copying = true
    this.setStatus(`Copying ${row.key} to clipboard…`)
    try {
      // Copy the original value, not its masked, truncated, or sanitized display.
      await this.writeClipboard(this.config[row.key])
      if (!this.closed && generation === this.generation) this.setStatus(`Copied ${row.key} to clipboard.`, 'success')
    } catch {
      // Clipboard backend errors may include stdin. Never display that output.
      if (!this.closed && generation === this.generation) this.setStatus('Could not copy value. Check your desktop session and clipboard tools; see README.', 'error')
    } finally {
      this.copying = false
    }
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
      content: 'NAVIGATION\n  t / p / a       Browse teams / pipelines / apps\n  j / k, ↑ / ↓    Move selection or scroll details\n  Enter           Open selected team, pipeline, or app\n  Tab / Shift-Tab Focus next / previous pane\n  /               Filter sidebar by name\n  Esc             Return to pipeline / workspace; clear filter\n  1–7             Select app view\n  h / l, [ / ]    Previous / next app view (also ← / →)\n  R / g           Refresh current app, pipeline, or workspace\n  o               Open current view in web dashboard\n  q / Ctrl-C      Quit\n\nAPP ACTIONS\n  s               Scale selected process in Overview / Resources\n  v               Reveal / hide selected config variable\n  y               Copy selected config value to clipboard\n  e / n / d       Replace / create / delete config variable\n  m               Toggle maintenance in Settings\n\nRemote changes require typing the exact target app name.\n--read-only disables every mutation at the API boundary.\nConfig values are masked and fetched only on opening Config.\nEach variable toggles independently; moving rows keeps values visible.\nLeaving the tab or app hides revealed values.\nCopying works while masked and in read-only mode.\n\nMetrics include throughput, latency, memory, and dyno load.\nSelect a metric for a two-hour sparkline and sample details.\nMissing samples are gaps; load average is not CPU percent.\n\nPress Esc, ?, or q to close help.'})
    this.modal = modal
    modal.key(['escape', '?', 'q'], () => { modal.destroy(); this.modal = null; previous?.focus(); this.render() })
    modal.focus()
    this.render()
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.metricsRequest?.controller.abort()
    this.metricsRequest = null
    this.telemetry = null
    clearInterval(this.timer)
    this.loading.clear()
    this.syncLoadingAnimation()
    this.generation++
    this.cancelPrompt?.()
    this.config = null
    if (!this.screen.destroyed) this.screen.destroy()
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
