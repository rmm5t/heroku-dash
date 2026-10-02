import {clean, single} from './text.js'
import {stateStyle} from './theme.js'
import {addonDetails, dynoDetails} from './resource-details.js'
import {dynoSizeLabel} from './dyno-size.js'
import {pendingSections, tabDefinition} from './tabs.js'
import {telemetryRows} from './telemetry.js'
import {recentReleases} from '../releases.js'

export {ansi, clean, single} from './text.js'
export {pendingSections, TABS} from './tabs.js'
export function age(date, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(date)) / 1000))
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`
}
const lines = entries => entries.map(([key, value]) => `${key.padEnd(17)} ${clean(value)}`).join('\n')
const row = (label, detail, extra = {}) => ({label: single(label), detail: clean(detail), ...extra})
const noticeColumns = (tab, label, status) => tabDefinition(tab)?.columns?.map((column, index) => index === 0 ? label : /State|Status/.test(column.label) ? status : '—')

function errorRows(tab, errors, sections) {
  return sections.filter(section => errors[section]).map(section => row(`${section} unavailable`, errors[section], {
    icon: 'error', tone: 'error', emphasis: 'Unavailable', columns: noticeColumns(tab, section, 'Unavailable'),
  }))
}

export const STAGES = ['development', 'review', 'staging', 'production']

export function sortApps(apps) {
  return [...apps].sort((a, b) => (STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage)) || a.name.localeCompare(b.name))
}

export function operationalMetrics(data) {
  const persistent = data.dynos.filter(d => data.formation.some(f => f.type === d.type))
  const desired = data.formation.reduce((sum, f) => sum + f.quantity, 0)
  const healthy = persistent.filter(d => d.state === 'up' || d.state === 'idle').length
  return {desired, healthy, total: data.dynos.length,
    crashed: data.dynos.filter(d => d.state === 'crashed').length,
    starting: data.dynos.filter(d => d.state === 'starting').length,
    coverage: desired ? Math.round(healthy / desired * 100) : null,
  }
}

function overviewRows(data) {
  const {app, formation, addons, errors} = data
  const releases = recentReleases(data.releases)
  const rows = []
  rows.push(row(`${app.name}  ·  ${app.maintenance ? 'MAINTENANCE' : 'ACTIVE'}`, lines([
    ['App', app.name], ['Team', app.team?.name ?? 'Personal / shared'], ['Region', app.region?.name],
    ['Stack', app.stack?.name], ['Generation', app.generation?.name], ['Web URL', app.web_url],
    ['Git URL', app.git_url], ['Created', app.created_at], ['Updated', app.updated_at], ['ID', app.id],
  ]), {...stateStyle(app.maintenance ? 'maintenance' : 'active'), emphasis: app.maintenance ? 'MAINTENANCE' : 'ACTIVE',
    columns: ['App', app.name, '—', app.maintenance ? 'MAINTENANCE' : 'ACTIVE']}))
  rows.push(row(`${formation.reduce((n, f) => n + f.quantity, 0)} configured dynos  ·  ${addons.length} add-ons`,
    'Select a process row in Overview or Resources and press s to scale it.\nUse Add-ons to inspect plans and attachments.\nConfig values are masked until explicitly revealed.', {
      icon: 'resources', columns: ['Total dynos', errors.addons ? 'Add-ons unavailable' : `${addons.length} add-ons`, errors.formation ? '—' : formation.reduce((n, f) => n + f.quantity, 0), errors.formation ? 'Unavailable' : 'Configured'],
    }))
  const orderedFormation = [...formation].sort((a, b) => Number(b.quantity > 0) - Number(a.quantity > 0))
  for (const f of orderedFormation) rows.push(row(`${f.type}  ·  ${f.quantity} × ${f.size}    [s] scale`, lines([
    ['Process', f.type], ['Quantity', f.quantity], ['Size', f.size], ['Command', f.command],
    ['Action', 'Press s to change quantity / size. Scaling may change billing.'],
  ]), {id: `overview:formation:${f.type}`, kind: 'formation', value: f, icon: 'resources', tone: f.quantity ? 'cyan' : 'muted', columns: [f.type, f.size, f.quantity, '[s] scale']}))
  const release = releases[0]
  if (release) {
    const releaseAge = age(release.created_at)
    const summary = `v${release.version} · ${releaseAge === '—' ? '—' : `${releaseAge} ago`} · ${single(release.description)}`
    rows.push(row(`Latest release: ${summary}  ·  ${release.status}`, lines([
      ['Version', `v${release.version}`], ['Status', release.status], ['Description', release.description],
      ['Age', releaseAge], ['Created', release.created_at],
    ]), {
      ...stateStyle(release.status), emphasis: release.status, columns: ['Latest release', summary, '—', release.status],
    }))
  }
  rows.push(...errorRows('Overview', errors, Object.keys(errors)))
  return rows
}

function resourceRows(data, {resources, dynoSizes}) {
  const {formation, dynos, errors} = data
  const sizes = new Map((dynoSizes ?? []).map(size => [size.name.toLowerCase(), size]))
  const sizeLabel = name => dynoSizeLabel({...sizes.get(name?.toLowerCase()), name})
  const rows = errorRows('Resources', errors, ['formation', 'dynos'])
  const byType = new Map()
  for (const dyno of dynos) {
    if (!byType.has(dyno.type)) byType.set(dyno.type, [])
    byType.get(dyno.type).push(dyno)
  }
  const appendDynos = members => {
    const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name, 'en', {numeric: true}))
    for (const [index, d] of sorted.entries()) {
      const treeBranch = index === sorted.length - 1 ? '└─' : '├─'
      const name = `  ${treeBranch} ${d.name}`
      rows.push(row(`${name}  ${d.state}  ${sizeLabel(d.size)}  ·  ${age(d.created_at)}`, lines([
        ['Dyno', d.name], ['Process', d.type], ['State', d.state], ['Size', sizeLabel(d.size)], ['Release', d.release ? `v${d.release.version}` : '—'],
        ['Age', age(d.created_at)], ['Created', d.created_at], ['Command', d.command], ['Actions', '[r] restart'],
      ]) + dynoDetails(resources, 'instances', d.name), {id: `dyno:${d.name}`, kind: 'dyno', value: d, treeBranch, ...stateStyle(d.state), emphasis: d.state,
        columns: [name, sizeLabel(d.size), '—', `${d.state} [r]`, age(d.created_at)]}))
    }
  }
  const appendProcess = f => {
    rows.push(row(`${f.type.padEnd(16)} ${String(f.quantity).padStart(3)} × ${f.size}    [s] scale  [x] stop  [r] restart`, lines([
      ['Process', f.type], ['Quantity', f.quantity], ['Size', f.size], ['Command', f.command],
      ['Updated', f.updated_at], ['Actions', '[s] scale   [x] stop   [r] restart'],
    ]) + dynoDetails(resources, 'formations', f.type), {id: `formation:${f.type}`, kind: 'formation', value: f, icon: 'resources', tone: f.quantity ? 'cyan' : 'muted', emphasis: f.type,
      columns: [f.type, f.size, f.quantity, '[s/x/r]', '—']}))
    appendDynos(byType.get(f.type) ?? [])
  }
  // Preserve the existing order within each partition and keep child dynos
  // with their process, including lingering dynos on a scaled-to-zero type.
  for (const f of formation.filter(f => f.quantity > 0)) appendProcess(f)
  const types = new Set(formation.map(f => f.type))
  const unmatched = dynos.filter(dyno => !types.has(dyno.type))
  if (unmatched.length) {
    rows.push(row('Other dynos', 'Dynos without a matching process in the formation snapshot.\nThis includes one-off runs, and can also occur when formation details are unavailable.\n\nSelect an individual dyno to inspect its state, command, and size.',
      {id: 'group:other-dynos', kind: 'group', icon: 'resources', tone: 'muted', columns: ['Other dynos', 'No formation match', unmatched.length, '—', '—']}))
    appendDynos(unmatched)
  }
  for (const f of formation.filter(f => !(f.quantity > 0))) appendProcess(f)
  return rows
}

function addonRows(data, {resources}) {
  const {addons, attachments, errors} = data
  const rows = errorRows('Add-ons', errors, ['addons', 'attachments'])
  const all = new Map(addons.map(addon => [addon.id, addon]))
  for (const attachment of attachments) if (!all.has(attachment.addon.id)) all.set(attachment.addon.id, attachment.addon)
  for (const addon of all.values()) {
    const enriched = resources?.data?.addons?.byId?.[addon.id]
    const state = enriched?.state ?? addon.state
    const service = addon.addon_service?.human_name ?? enriched?.service ?? addon.addon_service?.name ?? '—'
    const plan = enriched?.plan ?? addon.plan?.human_name ?? addon.plan?.name?.replace(/^[^:]+:/, '')
    rows.push(row(`${addon.name}  ·  ${addon.plan?.name ?? 'shared attachment'}  ·  ${state ?? '—'}`, lines([
      ['Name', addon.name], ['Service', addon.addon_service?.name ?? enriched?.service], ['Plan', addon.plan?.name ?? enriched?.plan],
      ['State', state], ['Billing app', addon.app?.name], ['Created', addon.created_at],
      ['Attachments', attachments.filter(a => a.addon.id === addon.id).map(a => a.name).join(', ') || '—'],
      ['Config keys', addon.config_vars?.join(', ')], ['ID', addon.id], ['Action', '[o] open this add-on’s management dashboard'],
    ]) + addonDetails(resources, addon.id), {id: `addon:${addon.id}`, kind: 'addon', value: addon, ...stateStyle(state), icon: /postgres|redis|mysql|mongo|key-value/i.test(addon.addon_service?.name ?? addon.plan?.name ?? '') ? 'database' : 'addons', emphasis: state,
      columns: [addon.name, service, plan, state]}))
  }
  return rows
}

function configRows(_data, {config, configError, revealed}) {
  const rows = []
  if (configError) rows.push(row('Config vars unavailable', configError, {icon: 'error', tone: 'error', emphasis: 'unavailable'}))
  else if (!config) rows.push(row('Loading config vars…', 'Config vars are fetched only when you open this tab.', {icon: 'refresh', tone: 'info'}))
  else if (!Object.keys(config).length) rows.push(row('No config vars', 'This app has no config vars.\n[Y] clone config vars from another app in this pipeline\n[n] new variable\nCloning requires the current app to remain empty.', {kind: 'empty-config', icon: 'lock', tone: 'muted'}))
  else for (const key of Object.keys(config).sort()) {
    const visible = revealed.has(key)
    const prefix = `${single(key)}\n\n`
    const value = visible ? clean(config[key]) || '(empty value)' : 'Value hidden. Press v to reveal this variable.'
    rows.push(row(`${key} = ${visible ? single(config[key]) : '••••••••'}`,
      `${prefix}${value}\n\n${visible ? 'Click the highlighted value to copy it.\n' : ''}[y] copy value   [v] reveal / hide (this variable)\n[e] replace value   [n] new variable   [x] delete\nConfig changes create a release and restart the app.`, {
        kind: 'config', key, icon: visible ? 'eye' : 'lock', tone: visible ? 'warning' : 'cyan', emphasis: key,
        valueRange: visible ? {start: prefix.length, end: prefix.length + value.length} : undefined,
      }))
  }
  return rows
}

function settingsRows(data) {
  const {app, domains, buildpacks, errors} = data
  const stack = app.stack?.name ?? '—'
  const buildStack = app.build_stack?.name ?? stack
  const stackLabel = stack === buildStack ? stack : `${stack} → ${buildStack} (next deploy)`
  const rows = []
  rows.push(row(`Maintenance mode: ${app.maintenance ? 'ON' : 'OFF'}    [m] toggle`, 'Press m to toggle maintenance mode. This changes how the app serves requests.', {icon: 'settings', tone: app.maintenance ? 'warning' : 'success', emphasis: app.maintenance ? 'ON' : 'OFF',
    columns: ['Maintenance', app.maintenance ? 'ON' : 'OFF', '[m] toggle']}))
  rows.push(row(`Region: ${app.region?.name}  ·  Stack: ${stackLabel}    [S] change stack`, lines([
    ['Region', app.region?.name], ['Stack', stack], ['Build stack', buildStack],
    ['Space', app.space?.name ?? 'Common Runtime'], ['ACM', app.acm ? 'Enabled' : 'Disabled'],
  ]) + '\n\n[S] change the build stack for the next deploy.\nDeploy the app again to apply the selected stack.',
  {id: 'settings:stack', icon: 'globe', tone: 'info', columns: ['Region / stack', `${app.region?.name ?? '—'} / ${stackLabel}`, '[S] change stack']}))
  rows.push(row('Add domain    [D] new', 'Press D to add a custom domain and optionally enable Automatic Certificate Management (ACM).\nACM is enabled for the entire app.\nConfigure DNS to point to the domain’s CNAME after adding it.',
    {id: 'action:add-domain', icon: 'globe', tone: 'cyan', columns: ['Add domain', 'Custom hostname / optional ACM', '[D] new']}))
  rows.push(...errorRows('Settings', errors, ['domains', 'buildpacks']))
  for (const domain of domains) {
    let detail = ''
    const copyRanges = []
    for (const [label, value] of [
      ['Hostname', domain.hostname], ['Kind', domain.kind], ['CNAME', domain.cname],
      ['Status', domain.status], ['ACM status', domain.acm_status], ['ACM reason', domain.acm_status_reason],
    ]) {
      const prefix = `${label.padEnd(17)} `
      const displayed = single(value)
      if (['Hostname', 'CNAME'].includes(label) && typeof value === 'string' && value.length) {
        copyRanges.push({start: detail.length + prefix.length, end: detail.length + prefix.length + displayed.length, label, value})
      }
      detail += `${prefix}${displayed}\n`
    }
    const removable = domain.kind === 'custom'
    detail += `\nClick the cyan Hostname or CNAME value to copy it.\n[D] add domain${removable ? '   [y] copy CNAME   [x] remove this domain' : ''}`
    rows.push(row(`Domain  ${domain.hostname}${removable ? '    [x] remove' : ''}`, detail, {id: `domain:${domain.hostname}`, kind: 'domain', value: domain,
      copyRanges, icon: 'globe', tone: 'info', columns: ['Domain', domain.hostname, `${domain.status ?? '—'}${removable ? ' [x] remove' : ''}`]}))
  }
  for (const item of buildpacks) rows.push(row(`Buildpack  ${item.ordinal}. ${item.buildpack?.name ?? item.buildpack?.url}`, lines([
    ['Buildpack', item.buildpack?.name], ['Order', item.ordinal], ['URL', item.buildpack?.url],
  ]), {icon: 'code', tone: 'accent', columns: [`Buildpack ${item.ordinal}`, item.buildpack?.name ?? item.buildpack?.url, '—']}))
  return rows
}

function releaseRows(data) {
  const releases = recentReleases(data.releases)
  const rows = errorRows('Releases', data.errors, ['releases'])
  for (const release of releases) rows.push(row(`v${String(release.version).padEnd(5)} ${release.status.padEnd(10)} ${age(release.created_at).padEnd(7)} ${single(release.user?.email)} ${release.description}`, lines([
    ['Version', `v${release.version}`], ['Status', release.status], ['Description', release.description],
    ['User', release.user?.email], ['Created', release.created_at], ['ID', release.id],
  ]), {...stateStyle(release.status), emphasis: release.status,
    columns: [`v${release.version}`, release.status, age(release.created_at), release.user?.email ?? '—', release.description]}))
  return rows
}

function metricsRows(data, {metrics}) {
  const {errors} = data
  const rows = telemetryRows(data, metrics)
  rows.push(...errorRows('Metrics', errors, ['dynos', 'formation']))
  const m = operationalMetrics(data)
  const available = !errors.dynos && !errors.formation
  rows.push(row(`Dyno health    ${available ? `${m.healthy} / ${m.desired} configured dynos up or idle` : 'unavailable'}`, available
    ? `${m.healthy} up / idle   ${m.starting} starting   ${m.crashed} crashed\n${m.total} total dynos, including one-off processes.\n\nBased on current dyno states, not historical availability.\nEco dynos in the idle state are counted as healthy.\nDuring a deploy, overlapping dynos can exceed the desired count.`
    : 'Dyno health cannot be computed because formation or dyno data is unavailable.',
  {id: 'health', icon: 'metrics', tone: !available ? 'muted' : m.crashed ? 'error' : m.healthy < m.desired ? 'warning' : 'success', emphasis: 'Dyno health',
    columns: ['Dyno health', available ? m.desired : '—', available ? m.healthy : '—', available ? 'Up / idle' : 'Unavailable']}))
  rows.push(row(`Snapshot: ${new Date(data.fetchedAt).toLocaleTimeString()}`, `Platform snapshot: ${data.fetchedAt}\n\nPerformance rows use separate time-bucketed data from api.metrics.heroku.com.\nSelect a metric for its sample time, resolution, coverage, and sparkline.\nPress R to refresh, or o to open the metrics dashboard.`, {id: 'snapshot', icon: 'clock', tone: 'muted',
    columns: ['Snapshot', '—', new Date(data.fetchedAt).toLocaleTimeString(), 'Fetched']}))
  return rows
}

const rowBuilders = new Map([
  ['Overview', overviewRows], ['Resources', resourceRows], ['Add-ons', addonRows],
  ['Config', configRows], ['Settings', settingsRows], ['Releases', releaseRows], ['Metrics', metricsRows],
])

export function appRows(tab, data, {config, configError, revealed = new Set(), resources, dynoSizes, metrics} = {}) {
  const pending = pendingSections(tab, data)
  if (pending.length) return [row(`Loading ${tab.toLowerCase()}…`, `Waiting for ${pending.join(', ')}.\n\nOther views remain available while these sections load.`, {icon: 'refresh', tone: 'info'})]
  const rows = rowBuilders.get(tab)?.(data, {config, configError, revealed, resources, dynoSizes, metrics}) ?? []
  const result = rows.length ? rows : [row('No items', `No ${tab.toLowerCase()} to display.`, {icon: 'search', tone: 'muted', columns: noticeColumns(tab, 'No items', 'Empty')})]
  for (const item of result) if (item.columns) item.columnLayout = tab
  return result
}
