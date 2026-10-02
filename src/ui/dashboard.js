import blessed from 'blessed'
import clipboard from 'clipboardy'
import {openExternalURL} from '../browser.js'
import packageJSON from '../../package.json' with {type: 'json'}
import {APP_STAGES, errorMessage, normalizeHostname, retryAfterMs, statusCode, validateAppName} from '../api.js'
import {AppSnapshotCache} from '../app-snapshot-cache.js'
import {executeHerokuCommand, executeInteractiveHerokuCommand, formatHerokuCommand, isInteractiveHerokuCommand, scopedHerokuCommand} from '../heroku-command.js'
import {resolveHierarchy} from '../hierarchy.js'
import {ReadRequests, withAbort} from '../read-requests.js'
import {autoRefreshSections, RefreshBackoff} from '../refresh-policy.js'
import {fetchTelemetry, METRICS_TIMEFRAMES, metricsScope, metricsTimeframe} from '../metrics.js'
import {parseDynoQuantity, validateConfigKey, validateDynoSize} from '../validation.js'
import {age, appRows, clean, single, sortApps, STAGES} from './views.js'
import {detailContent, domainValueAt, isValueClick} from './details.js'
import {tableColumns} from './columns.js'
import {createCommandViewer} from './command-viewer.js'
import {createLogViewer} from './log-viewer.js'
import {ModalLifecycle} from './modal-lifecycle.js'
import {enableReadline} from './readline.js'
import {runRead} from './read-operation.js'
import {pendingSections, TAB_DEFINITIONS, TABS} from './tabs.js'
import {badge, highlightKeys, icons, paint, palette, rowLabel, SCANNER_INTERVAL, scannerFrame, setTheme, shortcut, stageStyles, styleListSelection} from './theme.js'
import {detectTerminalTheme, ThemeInput} from './terminal-theme.js'
import {bindMovementKeys, frame} from './widget-helpers.js'

const SIDEBAR_WIDTH = '22%'
const VERSION = `v${packageJSON.version}`
const createScreen = input => blessed.screen({input, smartCSR: true, fullUnicode: true, title: 'heroku dash', dockBorders: true, autoPadding: true, sendFocus: true})
const descriptionContent = (description, highlightFirstLine) => {
  const text = clean(description)
  const newline = text.indexOf('\n')
  return highlightFirstLine
    ? `${highlightKeys(newline < 0 ? text : text.slice(0, newline), 'warning', true)}${newline < 0 ? '' : highlightKeys(text.slice(newline))}`
    : highlightKeys(text)
}

export class Dashboard {
  constructor({api, catalog, context, resources = null, refresh = 60, demo = false, theme = 'dark', screen, writeClipboard = clipboard.write,
    fetchMetrics = (data, options) => fetchTelemetry(api, data, options), executeHeroku = executeHerokuCommand,
    executeInteractiveHeroku = executeInteractiveHerokuCommand, appConfirm = new Map(), commandHistory = {entries: [], add() {}},
    logFilterHistory = {entries() { return [] }, add() {}}, openURL = openExternalURL}) {
    setTheme(theme)
    Object.assign(this, {api, catalog, context, resources, refresh, demo, theme, writeClipboard, fetchMetrics, executeHeroku, executeInteractiveHeroku, appConfirm, commandHistory, logFilterHistory, openURL})
    this.screen = screen ?? createScreen()
    this.tab = 0
    this.tabRanges = []
    this.mode = 'pipelines'
    this.team = context.team ?? null
    this.breadcrumbTeam = null
    this.pipeline = context.pipeline ?? null
    this.app = null
    this.rows = []
    this.updatingRows = false
    this.navItems = []
    this.generation = 0
    this.readRequests = new ReadRequests(() => !this.closed)
    this.config = null
    this.resourceData = {}
    this.resourceErrors = {}
    this.telemetry = null
    this.metricsError = null
    this.metricsRequest = null
    this.metricsSignature = null
    this.metricsRequestedAt = 0
    this.metricsWindowHours = 2
    this.revealed = new Set()
    this.copying = false
    this.commandRequest = null
    this.logRequest = null
    this.modalLifecycle = null
    this.interactiveRequest = null
    this.promotionRequest = null
    this.preparationRequest = null
    this.openingBrowser = false
    this.busy = false
    this.appSnapshots = new AppSnapshotCache()
    this.cachedSnapshot = false
    this.loading = new Map()
    this.loadingFrame = 0
    this.loadingTimer = null
    this.terminalFocused = true
    this.refreshPending = false
    this.refreshBackoff = new RefreshBackoff({interval: refresh * 1000})
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
    blessed.box({parent: this.header, top: 0, right: 2, width: VERSION.length, height: 1, tags: false,
      content: VERSION, style: {fg: palette.muted, bg: palette.panel}})
    this.nav = blessed.list({parent, top: 3, bottom: 4, left: 0, width: SIDEBAR_WIDTH, ...frame(), label: ` ${icons.pipelines}  Pipelines `, keys: true, mouse: true, tags: false,
      scrollbar: {ch: '│', style: {bg: palette.border}}, style: {...frame().style, selected: {bold: true}, item: {fg: palette.fg, bg: palette.bg}}})
    this.tabs = blessed.box({parent, top: 3, height: 3, left: SIDEBAR_WIDTH, right: 0, ...frame(), padding: {left: 1}, mouse: true, autoFocus: false, tags: false, style: {...frame().style, fg: palette.accent}})
    this.summary = blessed.box({parent, top: 6, height: 5, left: SIDEBAR_WIDTH, right: 0, padding: {left: 2, right: 1}, style: {fg: palette.fg, bg: palette.bg}})
    this.main = blessed.list({parent, top: 11, height: '40%-4', left: SIDEBAR_WIDTH, right: 0, ...frame(), label: ` ${icons.apps}  Apps `, keys: true, mouse: true, tags: false,
      scrollbar: {ch: '│', style: {bg: palette.border}}, style: {...frame().style, item: {fg: palette.fg, bg: palette.bg}}})
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
    this.footer = blessed.box({parent, bottom: 0, height: 2, left: 0, right: 0, padding: {left: 1}, tags: false, style: {fg: palette.fg, bg: palette.panel}})
    this.small = blessed.box({parent, top: 0, left: 0, right: 0, bottom: 0, hidden: true, style: {fg: palette.fg, bg: palette.bg}, valign: 'middle', align: 'center', content: highlightKeys('heroku dash\n\nPlease resize your terminal to at least 80 × 24.\n\nq / Ctrl-C to quit')})
    this.screen.on('resize', () => this.render())
    this.screen.on('blur', () => { this.terminalFocused = false })
    this.screen.on('focus', () => {
      this.terminalFocused = true
      if (this.refreshPending) this.autoRefresh()
    })
    this.screen.once('destroy', () => this.close())
    this.tabs.on('click', mouse => {
      if (this.closed || this.modal || this.small.visible || !this.app || mouse.button !== 'left') return
      const pos = this.tabs.lpos
      if (!pos || mouse.y !== pos.yi + this.tabs.itop || mouse.x >= pos.xl - this.tabs.iright) return
      const x = mouse.x - pos.xi - this.tabs.ileft
      const index = this.tabRanges.findIndex(range => x >= range.start && x < range.end)
      if (index < 0) return
      this.main.focus()
      if (index !== this.tab) this.changeTab(index)
      this.render()
    })
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
      const field = domainValueAt(this.detail, row, mouse)
      if (field && TABS[this.tab] === 'Settings') void this.copyValue(field.value, field.label)
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
      bindMovementKeys(list)
    }
    bindMovementKeys(this.detail)
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
    key(['T', 'S-t'], () => this.cycleMetricsTimeframe())
    key(['p'], () => this.setMode('pipelines'))
    key(['a'], () => this.setMode('apps'))
    key(['A', 'S-a'], () => void this.addApp())
    key(['P', 'S-p'], () => void this.promoteApp())
    key(['/'], () => void this.filterNav())
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
    key(['x'], () => {
      if (TABS[this.tab] === 'Config') void this.deleteConfig()
      else if (TABS[this.tab] === 'Settings') void this.removeDomain()
      else void this.dynoAction('stop')
    })
    key(['r'], () => void this.dynoAction('restart'))
    key(['y'], () => void (TABS[this.tab] === 'Settings' ? this.copyDomainCNAME() : this.copyConfig()))
    key(['Y', 'S-y'], () => void this.cloneConfigFromApp())
    key(['e'], () => void this.editConfig(false))
    key(['n'], () => void this.editConfig(true))
    key(['D', 'S-d'], () => void this.addDomain())
    key(['m'], () => void this.maintenance())
    key([':'], () => void this.customCommand())
    key(['C', 'S-c'], () => void this.customCommand('console'))
    key(['L', 'S-l'], () => void this.openLogs())
    key(['o'], () => void this.openBrowser())
    key(['?'], () => this.help())
  }

  async start() {
    if (this.context.team) this.mode = 'pipelines'
    this.drawNav()
    if (this.context.app) await this.openApp(this.context.app, this.context.pipeline)
    else if (this.pipeline) await this.openPipeline(this.pipeline)
    else this.drawLanding()
    if (this.closed) return
    const warnings = [...this.catalog.warnings, ...this.context.warnings ?? []]
    if (warnings.length) this.setStatus(warnings.join(' | '), 'warning')
    if (this.refresh && !this.closed) this.timer = setInterval(() => this.autoRefresh(), this.refresh * 1000)
    this.render()
  }

  autoRefresh() {
    if (!this.app || this.closed) return
    if (!this.terminalFocused) { this.refreshPending = true; return }
    if (this.modal || this.busy || this.readRequests.has('app')) return
    if (this.refreshBackoff.remaining) return
    this.refreshPending = false
    void this.loadApp(true)
  }

  setStatus(message, tone = 'info') { this.message = single(message); this.messageTone = tone; this.render() }

  recordRefreshResult(source, failures) {
    const remaining = this.refreshBackoff.record(source, failures)
    return this.refresh && remaining ? ` · Auto-refresh paused for ${Math.ceil(remaining / 1000)}s.` : ''
  }

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
    const tabs = compact => TAB_DEFINITIONS.map(({name, icon}, i) => i === this.tab
      ? paint(`[${i + 1} ${icons[icon]} ${name}]`, 'accent', true)
      : `${paint(i + 1, 'accent', true)}${paint(` ${icons[icon]}${compact ? '' : ` ${name}`}`, 'muted')}`)
    const fullTabs = tabs(false)
    const compact = blessed.unicode.strWidth(clean(fullTabs.join('  '))) > this.tabs.width - 4
    const labels = compact ? tabs(true) : fullTabs
    let offset = 0
    // Use the displayed labels' terminal-cell widths so hit areas stay aligned
    // with icons, brackets, and compact labels after a resize or tab change.
    this.tabRanges = this.app ? labels.map(label => {
      const range = {start: offset, end: offset + blessed.unicode.strWidth(clean(label))}
      offset = range.end + 2
      return range
    }) : []
    this.tabs.setContent(this.app ? labels.join('  ') : `${badge('pipelines', 'PIPELINE WORKSPACE')}  ${highlightKeys('· Enter an app', 'muted')}`)
    const appContext = Boolean(this.app)
    const footerContext = appContext ? this.pipeline ? 'pipeline-app' : 'app' : this.pipeline ? 'pipeline' : 'workspace'
    if (this.footerContext !== footerContext) {
      this.footerContext = footerContext
      const secondRow = [['j/k', 'move'], ['1–7 / [ ] / h l', 'views'], ['R/g', 'refresh'], ...(appContext ? [[':', 'command'], ['C', 'console'], ['L', 'logs']] : this.pipeline ? [['A', 'add app']] : []), ...(this.pipeline ? [['P', 'promote']] : []), ['o', 'browser'], ['?', 'help'], ['q', 'quit']]
      this.footer.setContent(`${[['t', 'teams'], ['p', 'pipelines'], ['a', 'apps'], ['/', 'filter'], ['Enter', 'open'], ['Tab', 'focus']].map(([key, text]) => shortcut(key, text)).join('  ')}\n${secondRow.map(([key, text]) => shortcut(key, text)).join('  ')}`)
    }
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
    this.logRequest?.close({restoreFocus: false})
    this.generation++
    this.readRequests.cancelAll()
    this.resetMetrics()
    this.resetResourceDetails()
    for (const key of ['app', 'pipeline', 'config']) this.loading.delete(key)
    this.syncLoadingAnimation()
    this.app = null
    this.breadcrumbTeam = null
    this.data = null
    this.cachedSnapshot = false
    this.appError = null
    this.config = null
    this.configError = null
    this.revealed.clear()
    this.busy = false
  }

  drawLanding() {
    this.summary.setContent(`${badge('heroku', 'Your Heroku workspace')}\n\n${highlightKeys('Browse teams, pipelines, and apps with t / p / a. Select an item and press Enter.', 'muted')}`)
    this.main.setLabel(` ${icons.heroku}  Welcome `)
    this.setRows([{icon: 'pipelines', label: 'Choose a pipeline or app in the sidebar', detail: 'Navigation\n\nTab cycles between sidebar, list, and details.\nj/k, Ctrl-N/Ctrl-P, or arrow keys move through lists.\n/ filters the sidebar.\n? displays all shortcuts.\n\nUse --app, --pipeline, --remote, or --team to choose a starting context.'}])
  }

  async openPipeline(pipeline) {
    this.clearApp()
    this.pipeline = pipeline
    const owner = pipeline.owner ?? this.catalog.pipelines.find(item => item.id === pipeline.id)?.owner
    this.breadcrumbTeam = owner?.type === 'team' ? this.catalog.teams.find(item => item.id === owner.id) ?? null : owner ? {name: 'Personal'} : null
    const request = this.readRequests.start('pipeline')
    const {signal} = request.controller
    this.summary.setContent(`${badge('pipelines', pipeline.name)}\n\n${badge('refresh', 'Loading pipeline apps…', 'info')}`)
    this.main.setLabel(` ${icons.apps}  Pipeline apps `)
    this.setRows([])
    this.main.focus()
    const finishLoading = this.beginLoading('pipeline', `Loading pipeline ${pipeline.name}…`)
    try {
      const [appsResult, hierarchy] = await withAbort(Promise.all([
        withAbort(this.api.pipelineApps(pipeline.id, {signal}), signal).then(apps => ({apps}), error => ({error})),
        resolveHierarchy(this.api, this.catalog, {pipeline, signal}),
      ]), signal)
      if (!request.current()) return
      this.pipeline = hierarchy.pipeline
      this.breadcrumbTeam = hierarchy.team
      if (appsResult.error) throw appsResult.error
      const apps = sortApps(appsResult.apps)
      this.pipelineApps = apps
      const unavailable = apps.filter(app => app.loadError).length
      this.summary.setContent(`${badge('pipelines', pipeline.name)}\n\n${STAGES.map(stage => badge(stageStyles[stage].icon, `${stage}: ${apps.filter(a => a.stage === stage).length}`, stageStyles[stage].tone)).join('   ')}`)
      this.setRows(apps.length ? apps.map(app => app.loadError ? {
        kind: 'unavailable-app', value: app, icon: 'warning', tone: 'warning', emphasis: app.stage.toUpperCase(),
        label: `${app.stage.toUpperCase().padEnd(13)} ${single(app.name)} · Unavailable`,
        columns: [app.stage.toUpperCase(), app.name, 'Unavailable', '—'], columnLayout: 'Pipeline apps',
        detail: `Unable to load app details\n\n${single(app.name)}\nID: ${single(app.id)}\nStage: ${single(app.stage)}\n\n${clean(app.loadError)}\n\nPress R to retry loading the pipeline.`,
      } : ({kind: 'app', value: app, ...stageStyles[app.stage], emphasis: app.stage.toUpperCase(),
        label: `${app.stage.toUpperCase().padEnd(13)} ${single(app.name)}  ·  ${app.region?.name ?? '—'}`,
        columns: [app.stage.toUpperCase(), app.name, app.region?.name, app.stack?.name], columnLayout: 'Pipeline apps',
        detail: `${single(app.name)}\n\nStage: ${app.stage}\nTeam: ${single(app.team?.name ?? 'Personal / shared')}\nRegion: ${single(app.region?.name)}\nStack: ${single(app.stack?.name)}\n\nEnter to view resources, add-ons, config, settings, releases, and metrics.\nP to promote the latest release to a higher stage.`,
      })) : [{icon: 'apps', tone: 'muted', label: 'This pipeline has no apps', detail: 'Press A to create an app in this pipeline, or a to browse accessible apps.'}])
      this.message = `Pipeline loaded. Select an app and press Enter, or press A to add an app.${unavailable ? ` · ${unavailable} app${unavailable === 1 ? '' : 's'} unavailable; select their rows for details.` : ''}${hierarchy.errors.hierarchy ? ` · ${hierarchy.errors.hierarchy}` : ''}`
      this.messageTone = unavailable || hierarchy.errors.hierarchy ? 'warning' : 'success'
    } catch (error) {
      if (request.current()) {
        this.setRows([{icon: 'error', tone: 'error', label: 'Unable to load pipeline', detail: errorMessage(error)}])
        this.message = errorMessage(error)
        this.messageTone = 'error'
      }
    } finally {
      if (request.current()) this.render()
      request.finish()
      finishLoading()
    }
  }

  async openApp(app, pipeline = null) {
    this.clearApp()
    this.app = app
    this.pipeline = pipeline
    this.breadcrumbTeam = app.team ?? null
    this.summary.setContent(`${badge('apps', app.name, 'cyan')}\n\n${badge('refresh', 'Loading app data…', 'info')}`)
    const cached = this.appSnapshots.get(app.id)
    if (cached) {
      this.data = cached
      this.app = cached.app
      this.pipeline = cached.coupling?.pipeline ?? null
      this.breadcrumbTeam = cached.app.team ?? null
      this.cachedSnapshot = true
      this.message = `Showing cached snapshot · ${age(cached.fetchedAt)} old. Refreshing…`
      this.messageTone = 'muted'
      void this.loadAppHierarchy(cached)
    }
    this.drawApp()
    this.main.focus()
    const config = TABS[this.tab] === 'Config' ? this.loadConfig() : null
    await Promise.all([this.loadApp(), config])
  }

  async loadApp(automatic = false, {forceResources = false} = {}) {
    if (!this.app || this.busy || this.closed) return false
    this.refreshPending = false
    const request = this.readRequests.start('app')
    const {signal} = request.controller
    const app = this.app
    const initial = !this.data
    const previous = automatic && this.data && !this.data.pending?.length ? this.data : undefined
    const sections = previous ? autoRefreshSections(previous) : undefined
    let progressive
    const finishLoading = this.beginLoading('app', `${this.data ? 'Refreshing' : 'Loading'} app ${app.name}…${this.cachedSnapshot ? ` · cached snapshot ${age(this.data.fetchedAt)} old` : ''}`)
    try {
      const data = await withAbort(this.api.appData(app.id, {signal, previous, sections, onUpdate: snapshot => {
        if (!initial || !request.current() || !snapshot.app) return
        // Keep the snapshot identity stable so unrelated sections completing
        // cannot invalidate in-flight resource enrichment or telemetry.
        progressive ??= {}
        Object.assign(progressive, snapshot)
        this.data = progressive
        this.app = snapshot.app
        if (!snapshot.pending.includes('coupling')) this.pipeline = snapshot.coupling?.pipeline ?? null
        this.breadcrumbTeam = snapshot.app.team ?? null
        this.drawApp({preserveScroll: true})
        void this.loadResourceDetails({force: forceResources})
        void this.loadMetrics()
      }}), signal)
      if (!request.current()) return
      const hierarchyChanged = !previous || sections.includes('coupling')
        || this.readRequests.has('hierarchy') || Boolean(previous.errors.hierarchy)
        || data.app.team?.id !== previous.app.team?.id || data.app.team?.name !== previous.app.team?.name
      if (hierarchyChanged) {
        this.pipeline = data.coupling?.pipeline ?? null
        this.breadcrumbTeam = data.app.team ?? null
      }
      else delete data.errors.hierarchy
      if (!progressive) this.resetResourceDetails()
      this.data = progressive ? Object.assign(progressive, data, {pending: []}) : data
      this.cachedSnapshot = false
      this.appSnapshots.set(this.data)
      this.app = data.app
      if (this.metricsSignature && this.metricsSignature !== metricsScope(data, this.metricsWindowHours)) this.resetMetrics()
      this.message = `${automatic ? 'Auto-refreshed' : 'Updated'} ${new Date(data.fetchedAt).toLocaleTimeString()}${Object.keys(data.errors).length ? ' · Some sections unavailable; see Overview.' : ''}`
      this.messageTone = Object.keys(data.errors).length ? 'warning' : 'success'
      this.message += this.recordRefreshResult('app', Object.values(data.failures ?? {}))
      this.drawApp({preserveScroll: Boolean(progressive) || automatic && TABS[this.tab] === 'Metrics'})
      if (hierarchyChanged) void this.loadAppHierarchy(this.data)
      void this.loadResourceDetails({force: forceResources})
      void this.loadMetrics({refresh: !progressive, force: !progressive && !automatic})
      return true
    } catch (error) {
      if (request.current()) {
        this.message = `${errorMessage(error)}${this.data ? ' · Showing previous snapshot.' : ''}`
        this.message += this.recordRefreshResult('app', [{statusCode: statusCode(error), retryAfterMs: retryAfterMs(error)}])
        this.messageTone = 'error'
        if (!this.data) {
          this.appError = errorMessage(error)
          this.drawApp()
        }
      }
      return false
    } finally {
      if (request.current()) this.render()
      request.finish()
      finishLoading()
    }
  }

  invalidateAppSnapshot(id) {
    this.appSnapshots.delete(id)
    if (this.app?.id === id) {
      // An already running read may predate the write. It must not repopulate
      // the cache after invalidation, including for arbitrary CLI commands.
      this.readRequests.cancel('app')
      this.readRequests.cancel('hierarchy')
    }
  }

  async loadAppHierarchy(data) {
    await runRead(this, 'hierarchy', {
      isCurrent: () => this.data === data,
      read: ({signal}) => resolveHierarchy(this.api, this.catalog, {app: data.app, pipeline: data.coupling?.pipeline, signal}),
      onSuccess: hierarchy => {
        this.pipeline = hierarchy.pipeline
        this.breadcrumbTeam = hierarchy.team
        delete data.errors.hierarchy
        Object.assign(data.errors, hierarchy.errors)
        if (hierarchy.errors.hierarchy) {
          this.message = `${this.message} · ${hierarchy.errors.hierarchy}`
          this.messageTone = 'warning'
          this.drawApp({preserveScroll: true})
        } else this.render()
      },
      onError: error => {
        data.errors.hierarchy = errorMessage(error)
        this.drawApp({preserveScroll: true})
      },
    })
  }

  drawApp({preserveScroll = false} = {}) {
    if (!this.app) return
    const {name: tab, icon} = TAB_DEFINITIONS[this.tab]
    this.main.setLabel(highlightKeys(` ${icons[icon]}  ${tab}${tab === 'Metrics' ? ` · ${metricsTimeframe(this.metricsWindowHours).label}  [T] timeframe` : ''} `))
    if (!this.data) {
      this.setRows(tab === 'Config' ? appRows(tab, {app: this.app, errors: {}}, {
        config: this.config, configError: this.configError, revealed: this.revealed,
      }) : this.appError ? [{icon: 'error', tone: 'error', label: 'Unable to load app', detail: this.appError}] : [{icon: 'refresh', tone: 'info', label: `Loading ${tab.toLowerCase()}…`,
        detail: `Loading ${tab.toLowerCase()} for ${single(this.app.name)}.\n\nYou can switch views, move between panes with Tab, or open another app while loading.`}], true)
      return
    }
    const scroll = this.detail.childBase
    const {app, formation, errors} = this.data
    const pending = this.data.pending ?? []
    this.summary.setContent(`${badge('apps', app.name, 'cyan')}   ${app.maintenance ? badge('warning', 'MAINTENANCE', 'warning') : badge('success', 'ACTIVE', 'success')}\n${badge('teams', app.team?.name ?? 'Personal / shared', 'muted')}  ·  ${badge('globe', app.region?.name, 'info')}  ·  ${badge('stack', app.stack?.name, 'muted')}\n${badge('resources', pending.includes('formation') ? 'Loading dynos…' : errors.formation ? 'Dynos unavailable' : `${formation.reduce((sum, f) => sum + f.quantity, 0)} configured dynos`, pending.includes('formation') ? 'info' : errors.formation ? 'warning' : 'fg')}  ·  ${badge('addons', pending.includes('addons') ? 'Loading add-ons…' : errors.addons ? 'Add-ons unavailable' : `${this.data.addons.length} add-ons`, pending.includes('addons') ? 'info' : errors.addons ? 'warning' : 'fg')}  ·  ${badge('refresh', this.refresh ? `refresh ${this.refresh}s` : 'manual refresh', 'muted')}`)
    if (this.cachedSnapshot) this.summary.setContent(`${this.summary.content}\n${badge('clock', `Cached snapshot · ${age(this.data.fetchedAt)} old`, 'warning')}`)
    this.setRows(appRows(tab, this.data, {
      config: this.config, configError: this.configError, revealed: this.revealed,
      resources: {provider: this.resources, data: this.resourceData, errors: this.resourceErrors},
      metrics: {snapshot: this.telemetry, error: this.metricsError, windowHours: this.metricsWindowHours},
    }), true)
    if (preserveScroll) { this.detail.setScroll(scroll); this.render() }
  }

  resetMetrics() {
    this.readRequests.cancel('metrics')
    this.metricsRequest = null
    this.telemetry = null
    this.metricsError = null
    this.metricsSignature = null
    this.metricsRequestedAt = 0
    this.loading.delete('metrics')
    this.syncLoadingAnimation()
  }

  cycleMetricsTimeframe() {
    if (TABS[this.tab] !== 'Metrics' || !this.app || this.busy) return
    const index = METRICS_TIMEFRAMES.findIndex(timeframe => timeframe.hours === this.metricsWindowHours)
    this.metricsWindowHours = METRICS_TIMEFRAMES[(index + 1) % METRICS_TIMEFRAMES.length].hours
    this.resetMetrics()
    this.drawApp()
    void this.loadMetrics({force: true})
  }

  async loadMetrics({refresh = false, force = false} = {}) {
    if (TABS[this.tab] !== 'Metrics' || !this.data || this.closed) return
    if (pendingSections('Metrics', this.data).length) return
    const signature = metricsScope(this.data, this.metricsWindowHours)
    if (this.metricsRequest && !force) return
    if (!force && !refresh && this.metricsSignature === signature && Date.now() - this.metricsRequestedAt < 30_000) return
    await runRead(this, 'metrics', {
      label: `Loading performance metrics · ${metricsTimeframe(this.metricsWindowHours).label}…`,
      onStart: request => {
        this.metricsRequest = request
        this.metricsSignature = signature
        this.metricsRequestedAt = Date.now()
        this.metricsError = null
      },
      read: ({signal}) => this.fetchMetrics(this.data, {signal, windowHours: this.metricsWindowHours}),
      onSuccess: snapshot => {
        this.telemetry = snapshot
        const failures = Object.values(snapshot.failures ?? {})
        const pause = this.recordRefreshResult('metrics', failures)
        if (failures.length && pause) {
          this.message = `Some performance metrics unavailable.${pause}`
          this.messageTone = 'warning'
        }
      },
      onError: error => {
        this.metricsError = errorMessage(error)
        const pause = this.recordRefreshResult('metrics', [{statusCode: statusCode(error), retryAfterMs: retryAfterMs(error)}])
        if (pause) { this.message = `${this.metricsError}${pause}`; this.messageTone = 'warning' }
      },
      onFinish: () => {
        this.metricsRequest = null
        if (TABS[this.tab] === 'Metrics') this.drawApp({preserveScroll: true})
      },
    })
  }

  resetResourceDetails() {
    this.resourceData = {}
    this.resourceErrors = {}
    for (const kind of ['dynos', 'addons']) {
      this.readRequests.cancel(`resources-${kind}`)
      this.loading.delete(`resources-${kind}`)
    }
    this.syncLoadingAnimation()
  }

  async loadResourceDetails({force = false} = {}) {
    const kind = TAB_DEFINITIONS[this.tab].resourceKind
    if (!kind || !this.resources?.available || !this.data || this.closed) return
    if (pendingSections(TABS[this.tab], this.data).length) return
    if (!force && (this.resourceData[kind] || this.resourceErrors[kind] || this.readRequests.has(`resources-${kind}`))) return
    const data = this.data
    await runRead(this, `resources-${kind}`, {
      label: `Loading ${kind === 'dynos' ? 'dyno costs and allocations' : 'add-on costs and limits'}…`,
      isCurrent: () => this.data === data,
      read: ({signal}) => this.resources[kind](data, {force, signal}),
      onSuccess: result => {
        this.resourceData[kind] = result
        delete this.resourceErrors[kind]
        this.recordRefreshResult(`resources-${kind}`, [])
      },
      onError: error => {
        this.resourceErrors[kind] = errorMessage(error)
        const pause = this.recordRefreshResult(`resources-${kind}`, [{statusCode: statusCode(error), retryAfterMs: retryAfterMs(error)}])
        if (pause) { this.message = `${this.resourceErrors[kind]}${pause}`; this.messageTone = 'warning' }
      },
      onFinish: () => {
        if (TAB_DEFINITIONS[this.tab].resourceKind === kind) {
          // getScroll() includes Blessed's cursor offset; childBase is the
          // actual first visible line that should survive this redraw.
          const scroll = this.detail.childBase
          this.drawApp()
          this.detail.setScroll(scroll)
          this.render()
        }
      },
    })
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
    await runRead(this, 'config', {
      label: `Loading config vars for ${this.app.name}…`,
      read: options => this.api.config(this.app.id, options),
      onSuccess: config => { this.config = config; this.configError = null },
      onError: error => { this.configError = errorMessage(error) },
      onFinish: () => this.drawApp(),
    })
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
    if (this.busy || this.closed || this.readRequests.has('app') || this.readRequests.has('pipeline')) return
    if (this.app) {
      const generation = this.generation
      const appId = this.app.id
      this.revealed.clear()
      await this.loadApp(false, {forceResources: true})
      if (!this.closed && generation === this.generation && this.app?.id === appId && TABS[this.tab] === 'Config') await this.loadConfig()
    } else if (this.pipeline) await this.openPipeline(this.pipeline)
    else {
      this.setStatus('Refreshing teams, pipelines, and apps…')
      await runRead(this, 'catalog', {
        label: 'Refreshing teams, pipelines, and apps…',
        read: options => this.api.catalog(options),
        onSuccess: catalog => {
          this.catalog = catalog
          this.drawNav()
          this.setStatus(catalog.warnings.join(' | ') || 'Workspace refreshed.', catalog.warnings.length ? 'warning' : 'success')
        },
        onError: error => this.setStatus(errorMessage(error), 'error'),
      })
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

  prompt(title, description, initial = '', {secret = false, tone = 'accent', icon = 'keyboard', highlightFirstLine = false, history, confirmationApp} = {}) {
    if (this.closed) return Promise.resolve(null)
    return new Promise(resolve => {
      const modal = blessed.box({parent: this.screen, top: 'center', left: 'center', width: '85%', height: confirmationApp ? 17 : 14, ...frame(), label: ` ${icons[secret ? 'lock' : icon]}  ${single(title)} `, style: {...frame().style, border: {fg: palette[tone]}}})
      const lifecycle = new ModalLifecycle(this, modal, {onClose: ({value}) => resolve(value)})
      blessed.box({parent: modal, top: 1, left: 2, right: 2, height: 6, content: descriptionContent(description, highlightFirstLine), tags: false,
        scrollable: true, mouse: true, scrollbar: {ch: '│', style: {bg: palette.border}}, style: {fg: palette.fg, bg: palette.bg}})
      if (confirmationApp) blessed.box({parent: modal, top: 8, left: 2, right: 2, height: 2, tags: false,
        content: `Target: ${paint(single(confirmationApp), 'warning', true)}\nType the exact app name above to apply this change.`,
        style: {fg: palette.warning, bg: palette.bg}})
      const input = blessed.textbox({parent: modal, top: confirmationApp ? 11 : 8, left: 2, right: 2, height: 3, ...frame(), inputOnFocus: true, censor: secret, value: initial})
      blessed.text({parent: modal, bottom: 0, left: 2, content: `${shortcut('Enter', 'continue')}   ${shortcut('Esc', 'cancel')}   ${shortcut('Ctrl-U', 'kill left')}${history ? `   ${shortcut('↑/↓', 'history')}` : ''}`, style: {bg: palette.bg}})
      enableReadline(input, history ?? [], () => this.render())
      lifecycle.addCleanup(() => {
        input._done?.('stop')
        input.clearValue()
      })
      const finish = value => lifecycle.close({value})
      input.on('submit', value => finish(value))
      input.on('cancel', () => finish(null))
      input.key(['C-c'], () => this.close())
      input.focus()
      this.render()
    })
  }

  writable() {
    if (this.api.readOnly) { this.setStatus('Read-only mode: remote changes are disabled.', 'warning'); return false }
    if (!this.app || !this.data || this.busy || this.readRequests.has('app')) return false
    return true
  }

  async confirm(app, description, {highlightFirstLine = false} = {}) {
    const value = await this.prompt('Confirm remote change', description, '', {icon: 'warning', tone: 'warning', highlightFirstLine, confirmationApp: app.name})
    if (value === null) { this.setStatus('Change cancelled.'); return null }
    if (value !== app.name) { this.setStatus('App name did not match. Nothing changed.', 'warning'); return null }
    return value
  }

  choose(title, description, choices, initial = 0) {
    if (this.closed) return Promise.resolve(null)
    return new Promise(resolve => {
      const modal = blessed.box({parent: this.screen, top: 'center', left: 'center', width: '75%', height: 16, ...frame(),
        label: ` ${icons.apps}  ${single(title)} `})
      const lifecycle = new ModalLifecycle(this, modal, {onClose: ({value}) => resolve(value)})
      blessed.box({parent: modal, top: 1, left: 2, right: 2, height: 3, content: highlightKeys(description), tags: false,
        style: {fg: palette.fg, bg: palette.bg}})
      const list = blessed.list({parent: modal, top: 5, bottom: 2, left: 2, right: 2, ...frame(), keys: true, mouse: true,
        items: choices.map(choice => single(choice.label)), style: {...frame().style, selected: {fg: palette.bg, bg: palette.accent}}})
      bindMovementKeys(list)
      blessed.text({parent: modal, bottom: 0, left: 2, content: `${shortcut('↑/↓', 'select')}   ${shortcut('Enter', 'continue')}   ${shortcut('Esc', 'cancel')}`, style: {bg: palette.bg}})
      const finish = value => lifecycle.close({value})
      list.on('select', (_item, index) => finish(choices[index].value))
      list.key(['escape'], () => finish(null))
      list.select(Math.max(0, initial))
      list.focus()
      this.render()
    })
  }

  async addApp() {
    if (!this.pipeline || this.app || this.busy || this.readRequests.has('pipeline')) return
    if (this.demo) { this.setStatus('App creation is disabled in the offline demo.', 'warning'); return }
    if (this.api.readOnly) { this.setStatus('Read-only mode: app creation is disabled.', 'warning'); return }
    let pipeline = this.pipeline
    const generation = this.generation
    const current = () => !this.closed && this.generation === generation && !this.app && this.pipeline?.id === pipeline.id
    let result
    try {
      result = await this.prepareRead('app-options', 'Loading runtime regions…', async options => {
        const [regions, details] = await Promise.all([
          this.api.appRegions(options),
          Object.hasOwn(pipeline, 'owner') ? pipeline : this.api.get(`/pipelines/${encodeURIComponent(pipeline.id)}`, options),
        ])
        if (!regions.length) throw new Error('No Common Runtime regions are available.')
        return {regions, pipeline: details}
      }, current, 'Loading Add App options…')
    } catch (error) { if (current()) this.setStatus(errorMessage(error), 'error'); return }
    if (!result || !current()) return
    const {regions} = result.value
    pipeline = result.value.pipeline
    const title = `Add App · ${pipeline.name}`
    const stage = await this.choose(`${title} · Stage`, 'Choose the pipeline stage for the new app.',
      APP_STAGES.map(value => ({label: value, value})), 1)
    if (stage === null || !current()) return
    const entered = await this.prompt(`${title} · Name`, `Stage: ${stage}\nEnter a globally unique app name (3–30 lowercase letters, digits, or hyphens).`, '', {icon: 'apps'})
    if (entered === null || !current()) return
    const name = entered.trim()
    try { validateAppName(name) }
    catch (error) { this.setStatus(errorMessage(error), 'warning'); return }
    const region = await this.choose(`${title} · Region`, 'Choose the location of the app’s Common Runtime.',
      regions.map(item => ({label: `${item.name} · ${item.description ?? item.name}`, value: item.name})),
      regions.findIndex(item => item.name === 'us'))
    if (region === null || !current()) return
    const owner = pipeline.owner?.type === 'team'
      ? this.catalog.teams.find(team => team.id === pipeline.owner.id)?.name ?? pipeline.owner.id
      : 'Personal account'
    const confirmation = await this.confirm({name}, `Create ${name}\nPipeline: ${pipeline.name} · Stage: ${stage}\nRegion: ${region} · Owner: ${owner}`, {highlightFirstLine: true})
    if (!confirmation || !current()) return
    const modal = blessed.box({parent: this.screen, top: 'center', left: 'center', width: '70%', height: 5, ...frame(),
      content: `\n  ${badge('refresh', `Creating ${name}…`, 'info')}`})
    const lifecycle = new ModalLifecycle(this, modal)
    this.busy = true
    const finishCreation = this.beginLoading('app-create', `Creating ${name} in ${pipeline.name}…`)
    try {
      const app = await this.api.createPipelineApp({pipeline, stage, name, region}, confirmation)
      this.catalog.apps = [...this.catalog.apps.filter(item => item.id !== app.id), app].sort((a, b) => a.name.localeCompare(b.name))
      if (this.closed) return
      await this.openPipeline(pipeline)
      this.drawNav()
      const index = this.rows.findIndex(row => row.value?.id === app.id)
      if (index >= 0) this.main.select(index)
      const refreshed = this.rows.some(row => row.value?.id === app.id)
      this.setStatus(refreshed
        ? `Created ${name} in ${pipeline.name} (${stage}, ${region}).`
        : `Created ${name}, but the pipeline view could not be refreshed. Press R to retry.`, refreshed ? 'success' : 'warning')
    } catch (error) {
      if (error.createdApp) {
        this.catalog.apps.push(error.createdApp)
        if (!this.closed) this.drawNav()
      }
      if (!this.closed) this.setStatus(errorMessage(error), 'error')
    } finally { lifecycle.close({restoreFocus: false, render: false}); this.busy = false; finishCreation(); this.render() }
  }

  async promoteApp() {
    if (!this.pipeline || this.busy || this.readRequests.has('pipeline') || this.readRequests.has('app')) return
    const selected = this.app ?? this.rows[this.main.selected]?.value
    if (!selected?.id || (!this.app && this.rows[this.main.selected]?.kind !== 'app')) return
    if (this.demo) { this.setStatus('App promotion is disabled in the offline demo.', 'warning'); return }
    if (this.api.readOnly) { this.setStatus('Read-only mode: app promotion is disabled.', 'warning'); return }
    const pipeline = this.pipeline
    const generation = this.generation
    const appContext = Boolean(this.app)
    const current = () => !this.closed && this.generation === generation && this.pipeline?.id === pipeline.id
      && (this.app?.id ?? this.rows[this.main.selected]?.value?.id) === selected.id
    let result
    try {
      result = await this.prepareRead('promotion-options', 'Loading promotion destinations…', async options => {
        const apps = await this.api.pipelineApps(pipeline.id, options)
        if (apps.some(app => app.loadError)) throw new Error('Some pipeline apps are unavailable. Refresh the pipeline before promoting.')
        return apps
      }, current)
    }
    catch (error) { if (current()) this.setStatus(errorMessage(error), 'error'); return }
    if (!result || !current()) return
    const apps = result.value
    const source = apps.find(app => app.id === selected.id)
    const sourceIndex = APP_STAGES.indexOf(source?.stage)
    if (!source || sourceIndex < 0 || sourceIndex === APP_STAGES.length - 1) {
      this.setStatus('This app has no higher stage available for promotion.', 'warning'); return
    }
    const stages = APP_STAGES.slice(sourceIndex + 1).filter(stage => apps.some(app => app.stage === stage))
    if (!stages.length) { this.setStatus('There are no apps in a higher stage to promote to.', 'warning'); return }
    const stage = await this.choose(`Promote · ${source.name}`, `Pipeline: ${pipeline.name}\nSource stage: ${source.stage}\nChoose a destination stage for the latest release.`,
      stages.map(stage => ({label: `${stage} · ${apps.filter(app => app.stage === stage).map(app => app.name).join(', ')}`, value: stage})))
    if (stage === null || !current()) return
    const targets = apps.filter(app => app.stage === stage)
    const confirmation = await this.confirm(source,
      `Promote ${source.name}: ${source.stage} → ${stage}\nPipeline: ${pipeline.name}\nDestinations: ${targets.map(app => app.name).join(', ')}\nDeploys the latest release and restarts destination dynos.`, {highlightFirstLine: true})
    if (!confirmation || !current()) return
    const modal = blessed.box({parent: this.screen, top: 'center', left: 'center', width: '80%', height: '60%', ...frame(),
      label: ` ${icons.pipelines}  Promoting ${single(source.name)} `, scrollable: true, keys: true, vi: true, mouse: true,
      content: `\n  ${badge('refresh', `Starting promotion to ${stage}…`, 'info')}`, scrollbar: {ch: '│', style: {bg: palette.border}}})
    bindMovementKeys(modal)
    const lifecycle = new ModalLifecycle(this, modal)
    modal.focus()
    this.busy = true
    const controller = new AbortController()
    const promotionRequest = {controller}
    this.promotionRequest = promotionRequest
    let finished = false
    lifecycle.addCleanup(() => {
      if (this.promotionRequest === promotionRequest) this.promotionRequest = null
      if (!finished) controller.abort()
    })
    const finishPromotion = this.beginLoading('promotion', `Promoting ${source.name} to ${stage}…`)
    let promotion
    for (const target of targets) this.invalidateAppSnapshot(target.id)
    try {
      promotion = await this.api.promotePipelineApp({pipeline, source, stage, targets}, confirmation)
      if (this.closed || lifecycle.closed) return
      const results = await this.api.waitForPromotion(promotion, targets, {signal: controller.signal, onUpdate: results => {
        if (this.closed || lifecycle.closed) return
        modal.setContent(`\n  ${badge('pipelines', `${source.name} → ${stage}`, 'info')}\n\n${targets.map(app => {
          const result = results.find(item => item.app.id === app.id)
          return `  ${badge(result?.status === 'failed' ? 'error' : 'apps', `${app.name}: ${result?.status ?? 'pending'}${result?.error_message ? ` · ${result.error_message}` : ''}`, result?.status === 'failed' ? 'error' : result?.status === 'succeeded' ? 'success' : 'info')}`
        }).join('\n')}`)
        this.render()
      }})
      if (this.closed || lifecycle.closed) return
      this.busy = false
      let refreshed
      if (appContext) refreshed = await this.loadApp()
      else {
        await this.openPipeline(pipeline)
        const index = this.rows.findIndex(row => row.value?.id === source.id)
        if (index >= 0) this.main.select(index)
        refreshed = index >= 0
      }
      const failures = results.filter(result => result.status === 'failed')
      this.setStatus(failures.length
        ? `Promotion failed for ${failures.map(result => `${targets.find(app => app.id === result.app.id)?.name ?? result.app.id}: ${result.error_message ?? 'failed'}`).join('; ')}`
        : `Promoted ${source.name} to ${stage}: ${targets.map(app => app.name).join(', ')}.${refreshed ? '' : ' Refresh failed; press R to retry.'}`,
      failures.length ? 'error' : refreshed ? 'success' : 'warning')
    } catch (error) {
      if (!this.closed && !lifecycle.closed) this.setStatus(`${promotion ? `Promotion ${promotion.id} started, but status tracking failed. ` : ''}${errorMessage(error)}`, 'error')
    } finally {
      finished = true
      lifecycle.close({restoreFocus: false, render: false})
      this.busy = false
      finishPromotion()
      if (!this.closed && !this.modal) { this.main.focus(); this.render() }
    }
  }

  confirmChoice(title, description, {highlightFirstLine = false} = {}) {
    if (this.closed) return Promise.resolve(false)
    return new Promise(resolve => {
      const modal = blessed.box({parent: this.screen, top: 'center', left: 'center', width: '75%', height: 13, ...frame(),
        label: ` ${icons.warning}  ${single(title)} `, style: {...frame().style, border: {fg: palette.warning}}})
      const lifecycle = new ModalLifecycle(this, modal, {onClose: ({value}) => resolve(value === true)})
      blessed.box({parent: modal, top: 1, left: 2, right: 2, height: 6, content: descriptionContent(description, highlightFirstLine), tags: false,
        style: {fg: palette.fg, bg: palette.bg}})
      const button = (content, left, tone) => blessed.box({parent: modal, bottom: 1, left, width: 22, height: 3, ...frame(),
        content: highlightKeys(content), align: 'center', valign: 'middle', mouse: true, tags: false,
        style: {...frame().style, fg: palette[tone], border: {fg: palette[tone]}}})
      const proceed = button('Continue (y)', '25%-11', 'success')
      const cancel = button('Cancel (n)', '75%-11', 'muted')
      let selected = true
      const select = value => {
        selected = value
        for (const [control, active] of [[proceed, selected], [cancel, !selected]]) {
          const tone = active ? 'success' : 'muted'
          control.style.fg = palette[tone]
          control.style.border.fg = palette[tone]
        }

        this.render()
      }
      const finish = value => lifecycle.close({value})
      modal.on('keypress', (_ch, key) => {
        if (key.name?.toLowerCase() === 'y') finish(true)
        if (key.name?.toLowerCase() === 'n' || key.name === 'escape') finish(false)
        if (key.name === 'left') select(true)
        if (key.name === 'right') select(false)
        if (key.name === 'enter') finish(selected)
      })
      proceed.on('click', () => finish(true))
      cancel.on('click', () => finish(false))
      modal.focus()
      this.render()
    })
  }

  async mutate(action, {successMessage = 'Change applied. App data refreshed.', selectRow} = {}) {
    // Lock navigation while a confirmed write is in flight. Its target and the
    // subsequent refresh must remain the app named in the confirmation.
    const modal = blessed.box({parent: this.screen, top: 'center', left: 'center', width: '70%', height: 5, ...frame(),
      content: `\n  ${badge('refresh', 'Applying confirmed change…', 'info')}`})
    const lifecycle = new ModalLifecycle(this, modal)
    this.busy = true
    this.setStatus('Applying change…')
    const finishLoading = this.beginLoading('mutation', 'Applying confirmed change…')
    this.invalidateAppSnapshot(this.app.id)
    try {
      await action()
      if (this.closed) return
      this.busy = false
      this.config = null
      this.revealed.clear()
      const refreshed = await this.loadApp()
      if (TABS[this.tab] === 'Config') await this.loadConfig()
      let selected = !selectRow
      if (selectRow) {
        const index = this.rows.findIndex(selectRow)
        if (index >= 0) { this.main.select(index); selected = true }
      }
      this.setStatus(refreshed
        ? `${successMessage}${selected ? '' : ' Domain details are not available yet; press R to refresh.'}`
        : `Change applied, but refresh failed. ${this.message}`, refreshed && selected ? 'success' : 'warning')
    } catch (error) {
      if (error.createdDomain && !this.closed) {
        this.busy = false
        await this.loadApp()
        const index = selectRow ? this.rows.findIndex(selectRow) : -1
        if (index >= 0) this.main.select(index)
      }
      if (!this.closed) this.setStatus(errorMessage(error), 'error')
    }
    finally { lifecycle.close({restoreFocus: false, render: false}); this.busy = false; finishLoading(); this.render() }
  }

  async scale() {
    if (!['Overview', 'Resources'].includes(TABS[this.tab]) || !this.writable()) return
    const row = this.rows[this.main.selected]
    if (row?.kind !== 'formation') { this.setStatus(`Select a process type (${icons.resources}) to scale.`); return }
    const app = this.app
    const formation = row.value
    const quantity = await this.prompt('Scale dynos · quantity', `${app.name} / ${formation.type}\nCurrent: ${formation.quantity} × ${formation.size}\nEnter desired quantity (0 stops this process).`, String(formation.quantity))
    if (quantity === null) return
    let numericQuantity
    try { numericQuantity = parseDynoQuantity(quantity, 'Quantity must be a non-negative integer.') }
    catch (error) { this.setStatus(errorMessage(error), 'warning'); return }
    const size = await this.prompt('Scale dynos · size', `${app.name} / ${formation.type}\nEnter a Heroku dyno size (for example Standard-1X).`, formation.size)
    if (size === null) return
    try { validateDynoSize(size, 'Dyno size cannot be blank.') }
    catch (error) { this.setStatus(errorMessage(error), 'warning'); return }
    const confirmation = await this.confirm(app, `Scale ${formation.type}: ${formation.quantity} × ${formation.size} → ${quantity} × ${size.trim()}.\nThis can restart dynos and change billing.`)
    if (confirmation) await this.mutate(() => this.api.scale(app.name, formation.type, numericQuantity, size, confirmation))
  }

  async dynoAction(action) {
    if (TABS[this.tab] !== 'Resources' || !this.writable()) return
    const row = this.rows[this.main.selected]
    if (action === 'stop' && row?.kind !== 'formation') {
      this.setStatus(`Select a process type (${icons.resources}) to stop. Individual dynos can only be restarted.`, 'warning')
      return
    }
    const app = this.app
    if (action === 'stop') {
      const formation = row.value
      const confirmation = await this.confirm(app, `Stop process ${formation.type} by scaling it from ${formation.quantity} × ${formation.size} to 0 × ${formation.size}.\nUse s to scale it back up later.`)
      if (confirmation) await this.mutate(() => this.api.scale(app.name, formation.type, 0, formation.size, confirmation))
      return
    }
    if (!['formation', 'dyno'].includes(row?.kind)) {
      this.setStatus(`Select a process type (${icons.resources}) or an individual dyno to restart.`, 'warning')
      return
    }
    const scope = row.kind === 'formation' ? 'process' : 'dyno'
    const target = scope === 'process' ? row.value.type : row.value.name
    const effect = scope === 'process'
      ? 'Heroku will restart every current dyno for this process type.'
      : 'Heroku will restart this dyno.'
    const confirmation = await this.confirm(app, `Restart ${scope} ${target}.\n${effect}`)
    if (confirmation) await this.mutate(() => this.api.restart(app.name, target, scope, confirmation))
  }

  async copyConfig() {
    if (TABS[this.tab] !== 'Config' || !this.app || !this.config || this.copying) return
    const row = this.rows[this.main.selected]
    if (row?.kind !== 'config' || typeof this.config[row.key] !== 'string') return
    // Copy the original value, not its masked, truncated, or sanitized display.
    await this.copyValue(this.config[row.key], row.key)
  }

  async cloneConfigFromApp() {
    if (TABS[this.tab] !== 'Config' || !this.app || this.busy) return
    if (this.demo) { this.setStatus('Config cloning is disabled in the offline demo.', 'warning'); return }
    if (!this.writable()) return
    if (!this.config || this.configError) { this.setStatus('Load or refresh Config before cloning config vars.', 'warning'); return }
    if (Object.keys(this.config).length) { this.setStatus('Config cloning is only allowed when the current app has no config vars.', 'warning'); return }
    if (!this.pipeline) { this.setStatus('Open an app in a pipeline to clone config vars from another app.', 'warning'); return }
    const destination = this.app
    const pipeline = this.pipeline
    const generation = this.generation
    const current = () => !this.closed && generation === this.generation && this.app?.id === destination.id && this.pipeline?.id === pipeline.id
    let result
    try { result = await this.prepareRead('config-clone-read', 'Loading source apps…', options => this.api.pipelineApps(pipeline.id, options), current) }
    catch (error) { if (current()) this.setStatus(errorMessage(error), 'error'); return }
    if (!result || !current()) return
    const apps = result.value
    const sources = apps.filter(app => app.id !== destination.id && !app.loadError)
    if (!sources.length) {
      this.setStatus(apps.some(app => app.id !== destination.id && app.loadError)
        ? 'Other pipeline apps are unavailable. Refresh the pipeline before cloning config vars.'
        : 'There are no other apps in this pipeline to clone config vars from.', 'warning')
      return
    }
    const source = await this.choose(`Clone Config · ${destination.name}`, `Pipeline: ${pipeline.name}\nChoose the app to clone config vars from into the current app.`,
      sources.map(app => ({label: `${app.name} · ${app.stage}`, value: app})))
    if (source === null || !current()) return
    try { result = await this.prepareRead('config-clone-read', 'Preparing config clone…', options => this.api.prepareConfigClone({pipeline, source, destination}, options), current) }
    catch (error) { if (current()) this.setStatus(errorMessage(error), 'error'); return }
    if (!result || !current()) return
    const plan = result.value
    const count = Object.keys(plan.values).length
    if (!count) { this.setStatus('There are no config vars to clone after excluding HEROKU_* variables.', 'warning'); return }
    const confirmation = await this.confirm(destination,
      `Clone ${count} config vars: ${source.name} → ${destination.name}\nPipeline: ${pipeline.name}\nThe current app must have no config vars.\nSkip ${plan.skippedCount} HEROKU_* vars.\nThis creates a release and restarts the current app.`, {highlightFirstLine: true})
    if (!confirmation || !current()) return
    await this.mutate(() => this.api.clonePipelineConfig(plan, confirmation), {
      successMessage: `Cloned ${count} config vars from ${source.name} into ${destination.name}. Config refreshed.`,
    })
  }

  prepareRead(key, label, read, isCurrent, modalLabel = label) {
    return runRead(this, key, {label, read, isCurrent, onStart: request => {
      const modal = blessed.box({parent: this.screen, top: 'center', left: 'center', width: '70%', height: 5, ...frame(),
        content: `\n  ${badge('refresh', modalLabel, 'info')}`})
      const lifecycle = new ModalLifecycle(this, modal)
      this.preparationRequest = request
      this.busy = true
      lifecycle.addCleanup(() => {
        if (request.current()) request.controller.abort()
        if (this.preparationRequest === request) {
          this.preparationRequest = null
          this.busy = false
        }
      })
      return () => { lifecycle.close({restoreFocus: false, render: false}); this.render() }
    }})
  }

  async copyDomainCNAME() {
    if (TABS[this.tab] !== 'Settings' || !this.app || this.copying) return
    const row = this.rows[this.main.selected]
    if (row?.kind !== 'domain' || row.value.kind !== 'custom') return
    const cname = row.value.cname
    if (typeof cname !== 'string' || !cname.length) { this.setStatus('CNAME is not available yet. Press R to refresh.', 'warning'); return }
    await this.copyValue(cname, 'CNAME')
  }

  async copyValue(value, label) {
    if (!this.app || this.copying) return
    const generation = this.generation
    this.copying = true
    this.setStatus(`Copying ${label} to clipboard…`)
    try {
      await this.writeClipboard(value)
      if (!this.closed && generation === this.generation) this.setStatus(`Copied ${label} to clipboard.`, 'success')
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
    try { validateConfigKey(key, 'Invalid config variable name.') }
    catch (error) { this.setStatus(errorMessage(error), 'warning'); return }
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

  async addDomain() {
    if (TABS[this.tab] !== 'Settings' || !this.writable()) return
    if (this.demo) { this.setStatus('Domain creation is disabled in the offline demo.', 'warning'); return }
    const app = this.app
    const generation = this.generation
    const current = () => !this.closed && generation === this.generation && this.app?.id === app.id
    const entered = await this.prompt('Add Domain · hostname', `${app.name}\nEnter a domain hostname, such as www.example.com.\nConfigure your DNS provider using the CNAME shown after creation.`, '', {icon: 'globe'})
    if (entered === null || !current()) return
    let hostname
    try { hostname = normalizeHostname(entered) }
    catch (error) { this.setStatus(errorMessage(error), 'warning'); return }
    const enableACM = app.acm ? false : await this.choose('Add Domain · SSL / ACM',
      'Automatic Certificate Management manages SSL certificates for the entire app.\nCertificates are issued after DNS is correctly configured.', [
        {label: 'Add domain only', value: false}, {label: 'Enable SSL with ACM (app-wide)', value: true},
      ])
    if (enableACM === null || !current()) return
    if (enableACM && hostname.startsWith('*.')) { this.setStatus('ACM does not support wildcard domains.', 'warning'); return }
    const confirmation = await this.confirm(app, `Add domain ${hostname}\n${app.acm ? 'ACM is already enabled for this app.' : enableACM ? 'Enable Automatic Certificate Management (ACM) for the entire app.' : 'Keep the app’s ACM setting unchanged.'}\nConfigure DNS using the new domain’s CNAME.`, {highlightFirstLine: true})
    if (!confirmation || !current()) return
    await this.mutate(() => this.api.addDomain(app.name, hostname, enableACM, confirmation), {
      successMessage: `Added ${hostname}.${enableACM ? ' ACM enabled; certificate issuance depends on DNS.' : ''} Select its cyan CNAME to copy the DNS target.`,
      selectRow: row => row.kind === 'domain' && row.value.hostname === hostname,
    })
  }

  async removeDomain() {
    if (TABS[this.tab] !== 'Settings' || !this.writable()) return
    if (this.demo) { this.setStatus('Domain removal is disabled in the offline demo.', 'warning'); return }
    const row = this.rows[this.main.selected]
    if (row?.kind !== 'domain' || row.value.kind !== 'custom') {
      this.setStatus('Select a custom domain to remove. The default Heroku domain cannot be removed.', 'warning')
      return
    }
    const app = this.app
    const domain = row.value
    const generation = this.generation
    const confirmation = await this.confirm(app, `Remove domain ${domain.hostname}\nThis app will stop serving requests for this hostname.`, {highlightFirstLine: true})
    if (!confirmation || this.closed || generation !== this.generation || this.app?.id !== app.id) return
    await this.mutate(() => this.api.removeDomain(app.name, domain, confirmation), {
      successMessage: `Removed ${domain.hostname}. Settings refreshed.`,
    })
  }

  async customCommand(initialCommand) {
    if (!this.app || this.busy) return
    if (this.demo) { this.setStatus('Heroku commands are disabled in the offline demo.', 'warning'); return }
    if (this.api.readOnly) { this.setStatus('Read-only mode: custom Heroku commands are disabled.', 'warning'); return }
    const app = this.app
    const value = initialCommand ?? await this.prompt(`Heroku command · ${app.name}`, `Enter the command after "heroku". The current app is added automatically.\nExample: logs --num 100\n\nConsole and Heroku run commands use the terminal interactively. App and remote selectors are rejected.`, '', {icon: 'code', history: this.commandHistory.entries})
    if (value === null) return
    let args
    try { args = scopedHerokuCommand(value, app.name, {appConfirm: this.appConfirm}) }
    catch (error) { this.setStatus(errorMessage(error), 'warning'); return }
    const invocation = formatHerokuCommand(args)
    const interactive = isInteractiveHerokuCommand(args)
    const appConfirmation = this.appConfirm.has(args[0])
    const description = `${invocation}\n\nCustom CLI commands can modify remote resources.${interactive ? '\nThis command will temporarily take over the terminal.' : ''}`
    const confirmed = appConfirmation
      ? await this.confirm(app, description, {highlightFirstLine: true})
      : await this.confirmChoice('Confirm Heroku command', `${description}\n\nTarget: ${app.name}`, {highlightFirstLine: true})
    if (!confirmed) {
      if (!appConfirmation) this.setStatus('Command cancelled.')
      return
    }
    if (this.closed || this.app?.id !== app.id) return
    await this.commandHistory.add(value)
    if (interactive) await this.interactiveCommand(app, args, invocation)
    else await this.commandPane(app, args, invocation)
  }

  async interactiveCommand(app, args, invocation) {
    this.invalidateAppSnapshot(app.id)
    const previous = this.screen.focused
    const controller = new AbortController()
    const request = {controller}
    const program = this.screen.program
    const filteredInput = program.input
    const source = filteredInput instanceof ThemeInput ? filteredInput.source : null
    this.interactiveRequest = request
    this.busy = true
    this.setStatus(`Starting ${invocation}…`)
    // leave() flushes mouse and keypad resets before pause() suppresses output.
    // Otherwise mouse-motion reports can leak into the child command's stdin.
    this.screen.leave()
    program.clear()
    program.flush()
    if (source) { source.unpipe(filteredInput); source.pause() }
    const resume = program.pause()
    let result
    let failure
    try {
      result = await this.executeInteractiveHeroku(args, {signal: controller.signal})
    } catch (error) {
      failure = error
    } finally {
      if (this.interactiveRequest === request) this.interactiveRequest = null
      this.busy = false
      if (!this.screen.destroyed) {
        resume()
        program.clear()
        program.flush()
        if (source && !filteredInput.destroyed) source.pipe(filteredInput)
        this.screen.enter()
        this.screen.realloc()
        previous?.focus()
        if (failure) this.setStatus(errorMessage(failure), 'error')
        else if (result?.code === 0) this.setStatus('Interactive Heroku command completed.', 'success')
        else this.setStatus(`Interactive Heroku command exited with ${result?.signal ?? `code ${result?.code}`}.`, 'warning')
        this.render()
      }
    }
  }

  async commandPane(app, args, invocation) {
    this.invalidateAppSnapshot(app.id)
    const viewer = createCommandViewer({owner: this, appName: app.name,
      execute: (argv, options) => this.executeHeroku(argv, options), render: () => this.render(),
      setStatus: (message, tone) => this.setStatus(message, tone),
      isCurrent: () => this.commandRequest === viewer,
      onClose: () => { if (this.commandRequest === viewer) this.commandRequest = null },
    })
    this.commandRequest = viewer
    await viewer.run(args, invocation)
  }

  async openLogs() {
    if (!this.app || this.closed || this.busy || this.modal) return
    if (this.demo) { this.setStatus('Log streaming is disabled in the offline demo.', 'warning'); return }
    const app = this.app
    const generation = this.generation
    const viewer = createLogViewer({owner: this, appName: app.name,
      execute: (argv, options) => this.executeHeroku(argv, options), render: () => this.render(),
      setStatus: (message, tone) => this.setStatus(message, tone),
      isCurrent: () => this.logRequest === viewer && generation === this.generation && this.app?.id === app.id,
      onClose: () => { if (this.logRequest === viewer) this.logRequest = null },
      closeDashboard: () => this.close(), history: this.logFilterHistory,
      historyScope: () => {
        if (this.pipeline?.id) return `pipeline:${this.pipeline.id}`
        if (!this.data || this.data.pending?.includes('coupling') || this.data.errors.coupling) return null
        return `app:${app.id}`
      },
    })
    this.logRequest = viewer
    await viewer.run(scopedHerokuCommand('logs --tail --num 100', app.name))
  }

  async openBrowser() {
    if (this.demo) { this.setStatus('Browser links are disabled in the offline demo.'); return }
    if (this.openingBrowser || this.closed) return
    const app = this.app
    const tab = this.tab
    const generation = this.generation
    const addonContext = Boolean(app && TABS[tab] === 'Add-ons')
    const row = this.rows[this.main.selected]
    const addon = addonContext && row?.kind === 'addon' ? row.value : null
    if (addonContext && !addon) { this.setStatus('Select an add-on to open its management dashboard.', 'warning'); return }
    const attachment = addon ? this.data?.attachments.find(item => item.addon.id === addon.id) : null
    const current = () => !this.closed && generation === this.generation && this.tab === tab
      && this.app?.id === app?.id && (!addon || this.rows[this.main.selected]?.value?.id === addon.id)
    const request = this.readRequests.start('browser', current)
    const {signal} = request.controller
    let url
    if (app && !addon) {
      const path = TAB_DEFINITIONS[tab].browserPath
      const processType = TABS[tab] === 'Metrics' ? row?.processType : null
      url = `https://dashboard.heroku.com/apps/${encodeURIComponent(app.name)}/${path}${processType ? `/${encodeURIComponent(processType)}` : ''}`
    } else if (this.pipeline) url = `https://dashboard.heroku.com/pipelines/${encodeURIComponent(this.pipeline.id)}`
    else if (this.team) url = `https://dashboard.heroku.com/teams/${encodeURIComponent(this.team.name)}/apps`
    else url = 'https://dashboard.heroku.com/apps'
    this.openingBrowser = true
    const name = addon?.name ?? attachment?.name ?? 'selected add-on'
    const finishLoading = this.beginLoading('browser', addon ? `Opening ${name} management dashboard…` : 'Opening Heroku dashboard…')
    try {
      if (addon) url = await withAbort(this.api.addonDashboardUrl(addon, attachment, app, {signal}), signal)
      if (!request.current()) return
      await this.openURL(url)
      if (request.current()) this.setStatus(addon ? `Opened ${name} management dashboard in your browser.` : 'Opened Heroku dashboard in your browser.', 'success')
    } catch (error) {
      if (request.current()) this.setStatus(`Unable to open browser: ${errorMessage(error)}`, 'error')
    } finally { request.finish(); this.openingBrowser = false; finishLoading() }
  }

  help() {
    const modal = blessed.box({parent: this.screen, top: 'center', left: 'center', width: '85%', height: '85%', ...frame(), label: ` ${icons.keyboard}  Keyboard shortcuts `, padding: {left: 2, top: 1}, scrollable: true, keys: true, vi: true,
      content: 'NAVIGATION\n  t / p / a       Browse teams / pipelines / apps\n  j / k, ↑ / ↓    Move selection or scroll details\n  Ctrl-N / Ctrl-P Move down / up in lists or scrollable panes\n  Enter           Open selected team, pipeline, or app\n  Tab / Shift-Tab Focus next / previous pane\n  /               Filter sidebar by name\n  1–7             Select app view\n  h / l, [ / ]    Previous / next app view (also ← / →)\n  R / g           Refresh current app, pipeline, or workspace\n  o               Open current view / selected add-on dashboard\n  q / Ctrl-C      Quit\n\nPIPELINE ACTIONS\n  A               Create an app: stage, name, and runtime region\n  P               Promote the selected app to a higher stage\n                  Also works from an app view within a pipeline\n\nAPP ACTIONS\n  :               Run app-scoped Heroku CLI command\n  C               Open the default app console\n  s               Scale selected process in Overview / Resources\n  x               Stop process / delete config var / remove custom domain\n  r               Restart selected process or dyno in Resources\n  v               Reveal / hide selected config variable\n  y               Copy config value / custom domain CNAME to clipboard\n  Y (Config)      Clone from a pipeline app into this app, only if empty\n  e / n           Replace / create config variable\n  D               Add a domain and optionally enable ACM in Settings\n  m               Toggle maintenance in Settings\n  T (Metrics)     Cycle Past 2 / 24 / 72 hours / 7 days\n\nBuilt-in remote changes require typing the exact target app name.\nAll text inputs support readline editing shortcuts.\nCustom commands use y/n or ←/→ and Enter for confirmation.\nConsole and Heroku run commands temporarily take over the terminal.\n--read-only disables mutations and custom commands.\nCustom commands reject app / remote selectors.\nStopping a process scales it to 0; use s to scale it back up.\nConfig values are masked and fetched only on opening Config.\nEach variable toggles independently; moving rows keeps values visible.\nLeaving the tab or app hides revealed values.\nCopying works while masked and in read-only mode.\nClick cyan domain Hostname / CNAME values to copy them.\n\nMetrics include throughput, latency, memory, and dyno load.\nSelect a metric for a chart over the chosen timeframe and sample details.\nMissing samples are gaps; load average is not CPU percent.\n\nPress Esc, ?, or q to close help.'})
    modal.setContent(highlightKeys(`${modal.content}\n\nLOG VIEWER\n  L               Tail logs for the current app (also in read-only mode)\n  p / Space       Pause / resume display; scrolling up also pauses\n  /               Filter buffered lines (text or regex; case-insensitive)\n  ↑/↓, Ctrl-P/N   Browse pipeline filter history in the filter input\n  End             Resume following the latest logs\n  Esc / q         Close viewer and stop streaming`))
    const lifecycle = new ModalLifecycle(this, modal)
    bindMovementKeys(modal)
    modal.key(['escape', '?', 'q'], () => lifecycle.close())
    modal.focus()
    this.render()
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.modalLifecycle?.close({restoreFocus: false})
    this.readRequests.cancelAll()
    this.metricsRequest = null
    this.interactiveRequest?.controller.abort()
    this.interactiveRequest = null
    this.telemetry = null
    clearInterval(this.timer)
    this.loading.clear()
    this.syncLoadingAnimation()
    this.generation++
    this.config = null
    this.appSnapshots.clear()
    if (!this.screen.destroyed) this.screen.destroy()
  }
}

export async function runDashboard(options) {
  const input = !options.screen && (options.theme ?? 'auto') === 'auto' ? new ThemeInput(process.stdin) : null
  const screen = options.screen ?? createScreen(input ?? undefined)
  const controller = new AbortController()
  let dashboard
  const finished = new Promise(resolve => screen.once('destroy', () => { controller.abort(); resolve() }))
  const stop = () => { controller.abort(); if (dashboard) dashboard.close(); else screen.destroy() }
  const interrupt = () => { if (!dashboard?.interactiveRequest) stop() }
  const startupKey = (_ch, key) => { if (key.full === 'C-c' || key.full === 'q') stop() }
  // Enable raw input while detecting the theme and allow immediate cancellation.
  screen.on('keypress', startupKey)
  process.once('SIGTERM', stop)
  process.on('SIGINT', interrupt)
  try {
    const theme = await detectTerminalTheme({input: screen.program.input, output: screen.program.output,
      theme: options.theme, signal: controller.signal})
    if (screen.destroyed) return
    screen.removeListener('keypress', startupKey)
    dashboard = new Dashboard({...options, screen, theme})
    await dashboard.start()
    await finished
  } finally {
    if (dashboard) dashboard.close()
    else if (!screen.destroyed) screen.destroy()
    input?.destroy()
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', interrupt)
  }
}
