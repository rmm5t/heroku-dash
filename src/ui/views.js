import {clean, single} from './text.js'
import {stateStyle} from './theme.js'
import {addonDetails, dynoDetails} from './resource-details.js'
import {TABLE_COLUMNS} from './columns.js'
import {telemetryRows} from './telemetry.js'

export {ansi, clean, single} from './text.js'
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
export const TABS = ['Overview', 'Resources', 'Add-ons', 'Config', 'Settings', 'Releases', 'Metrics']
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

export function appRows(tab, data, {config, configError, revealed = new Set(), resources, metrics} = {}) {
  const {app, formation, dynos, addons, attachments, releases, domains, buildpacks, errors} = data
  const rows = []
  const noticeColumns = (label, status) => TABLE_COLUMNS[tab]?.map((column, index) => index === 0 ? label : /State|Status/.test(column.label) ? status : '—')
  const error = section => {
    if (errors[section]) rows.push(row(`${section} unavailable`, errors[section], {
      icon: 'error', tone: 'error', emphasis: 'Unavailable',
      columns: noticeColumns(section, 'Unavailable'),
    }))
  }
  if (tab === 'Overview') {
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
    if (releases[0]) rows.push(row(`Latest release: v${releases[0].version}  ·  ${releases[0].status}`, releases[0].description, {
      ...stateStyle(releases[0].status), emphasis: releases[0].status, columns: ['Latest release', `v${releases[0].version}`, '—', releases[0].status],
    }))
    for (const section of Object.keys(errors)) error(section)
  }
  if (tab === 'Resources') {
    error('formation'); error('dynos')
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
        rows.push(row(`${name}  ${d.state}  ${d.size}  ·  ${age(d.created_at)}`, lines([
          ['Dyno', d.name], ['Process', d.type], ['State', d.state], ['Size', d.size], ['Release', d.release ? `v${d.release.version}` : '—'],
          ['Age', age(d.created_at)], ['Created', d.created_at], ['Command', d.command],
        ]) + dynoDetails(resources, 'instances', d.name), {id: `dyno:${d.name}`, kind: 'dyno', value: d, treeBranch, ...stateStyle(d.state), emphasis: d.state,
          columns: [name, d.size, '—', d.state, age(d.created_at)]}))
      }
    }
    const appendProcess = f => {
      rows.push(row(`${f.type.padEnd(16)} ${String(f.quantity).padStart(3)} × ${f.size}    [s] scale`, lines([
        ['Process', f.type], ['Quantity', f.quantity], ['Size', f.size], ['Command', f.command],
        ['Updated', f.updated_at], ['Action', 'Press s to change quantity / size. Scaling may change billing.'],
      ]) + dynoDetails(resources, 'formations', f.type), {id: `formation:${f.type}`, kind: 'formation', value: f, icon: 'resources', tone: f.quantity ? 'cyan' : 'muted', emphasis: f.type,
        columns: [f.type, f.size, f.quantity, '[s] scale', '—']}))
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
  }
  if (tab === 'Add-ons') {
    error('addons'); error('attachments')
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
        ['Config keys', addon.config_vars?.join(', ')], ['ID', addon.id],
      ]) + addonDetails(resources, addon.id), {...stateStyle(state), icon: /postgres|redis|mysql|mongo|key-value/i.test(addon.addon_service?.name ?? addon.plan?.name ?? '') ? 'database' : 'addons', emphasis: state,
        columns: [addon.name, service, plan, state]}))
    }
  }
  if (tab === 'Config') {
    if (configError) rows.push(row('Config vars unavailable', configError, {icon: 'error', tone: 'error', emphasis: 'unavailable'}))
    else if (!config) rows.push(row('Loading config vars…', 'Config vars are fetched only when you open this tab.', {icon: 'refresh', tone: 'info'}))
    else for (const key of Object.keys(config).sort()) {
      const visible = revealed.has(key)
      const prefix = `${single(key)}\n\n`
      const value = visible ? clean(config[key]) || '(empty value)' : 'Value hidden. Press v to reveal this variable.'
      rows.push(row(`${key} = ${visible ? single(config[key]) : '••••••••'}`,
        `${prefix}${value}\n\n${visible ? 'Click the highlighted value to copy it.\n' : ''}[y] copy value   [v] reveal / hide (this variable)\n[e] replace value   [n] new variable   [d] delete\nConfig changes create a release and restart the app.`, {
          kind: 'config', key, icon: visible ? 'eye' : 'lock', tone: visible ? 'warning' : 'cyan', emphasis: key,
          valueRange: visible ? {start: prefix.length, end: prefix.length + value.length} : undefined,
        }))
    }
  }
  if (tab === 'Settings') {
    rows.push(row(`Maintenance mode: ${app.maintenance ? 'ON' : 'OFF'}    [m] toggle`, 'Press m to toggle maintenance mode. This changes how the app serves requests.', {icon: 'settings', tone: app.maintenance ? 'warning' : 'success', emphasis: app.maintenance ? 'ON' : 'OFF',
      columns: ['Maintenance', app.maintenance ? 'ON' : 'OFF', '[m] toggle']}))
    rows.push(row(`Region: ${app.region?.name}  ·  Stack: ${app.stack?.name}`, lines([
      ['Region', app.region?.name], ['Stack', app.stack?.name], ['Build stack', app.build_stack?.name],
      ['Space', app.space?.name ?? 'Common Runtime'], ['ACM', app.acm ? 'Enabled' : 'Disabled'],
    ]), {icon: 'globe', tone: 'info', columns: ['Region / stack', `${app.region?.name ?? '—'} / ${app.stack?.name ?? '—'}`, '—']}))
    error('domains'); error('buildpacks')
    for (const domain of domains) rows.push(row(`Domain  ${domain.hostname}`, lines([
      ['Hostname', domain.hostname], ['Kind', domain.kind], ['CNAME', domain.cname],
      ['Status', domain.status], ['ACM status', domain.acm_status], ['ACM reason', domain.acm_status_reason],
    ]), {icon: 'globe', tone: 'info', columns: ['Domain', domain.hostname, domain.status]}))
    for (const item of buildpacks) rows.push(row(`Buildpack  ${item.ordinal}. ${item.buildpack?.name ?? item.buildpack?.url}`, lines([
      ['Buildpack', item.buildpack?.name], ['Order', item.ordinal], ['URL', item.buildpack?.url],
    ]), {icon: 'code', tone: 'accent', columns: [`Buildpack ${item.ordinal}`, item.buildpack?.name ?? item.buildpack?.url, '—']}))
  }
  if (tab === 'Releases') {
    error('releases')
    for (const release of releases) rows.push(row(`v${String(release.version).padEnd(5)} ${release.status.padEnd(10)} ${age(release.created_at).padEnd(7)} ${release.description}`, lines([
      ['Version', `v${release.version}`], ['Status', release.status], ['Description', release.description],
      ['User', release.user?.email], ['Created', release.created_at], ['ID', release.id],
    ]), {...stateStyle(release.status), emphasis: release.status}))
  }
  if (tab === 'Metrics') {
    rows.push(...telemetryRows(data, metrics))
    error('dynos'); error('formation'); error('releases')
    const m = operationalMetrics(data)
    const available = !errors.dynos && !errors.formation
    rows.push(row(`Dyno health    ${available ? `${m.healthy} / ${m.desired} configured dynos up or idle` : 'unavailable'}`, available
      ? `${m.healthy} up / idle   ${m.starting} starting   ${m.crashed} crashed\n${m.total} total dynos, including one-off processes.\n\nBased on current dyno states, not historical availability.\nEco dynos in the idle state are counted as healthy.\nDuring a deploy, overlapping dynos can exceed the desired count.`
      : 'Dyno health cannot be computed because formation or dyno data is unavailable.',
    {id: 'health', icon: 'metrics', tone: !available ? 'muted' : m.crashed ? 'error' : m.healthy < m.desired ? 'warning' : 'success', emphasis: 'Dyno health',
      columns: ['Dyno health', available ? m.desired : '—', available ? m.healthy : '—', available ? 'Up / idle' : 'Unavailable']}))
    for (const f of formation) {
      const members = dynos.filter(d => d.type === f.type)
      const running = members.filter(d => ['up', 'idle'].includes(d.state)).length
      const crashed = members.some(d => d.state === 'crashed')
      const status = errors.dynos ? 'Unavailable' : crashed ? 'Crashed' : running < f.quantity ? 'Below target' : !f.quantity && !running ? 'Scaled to 0' : 'Up / idle'
      const detail = lines([['Process', f.type], ['Desired', f.quantity], ['Running', errors.dynos ? 'Unavailable' : running]])
        + '\n\n' + (errors.dynos ? `Dyno data unavailable: ${errors.dynos}` : members.map(d => `${d.name.padEnd(22)} ${d.state.padEnd(10)} age ${age(d.created_at)}`).join('\n') || 'No dynos currently running.')
      rows.push(row(`${f.type}  ·  desired ${f.quantity}  ·  running ${running}`, detail,
        {id: `health:${f.type}`, icon: 'resources', tone: errors.dynos ? 'muted' : crashed ? 'error' : running < f.quantity ? 'warning' : f.quantity ? 'success' : 'muted', emphasis: status,
          columns: [f.type, f.quantity, errors.dynos ? '—' : running, status]}))
    }
    if (!errors.releases) rows.push(row(`Deployments    ${releases.filter(r => r.status === 'succeeded').length} succeeded / ${releases.length} recent releases`,
      `Latest ${releases.length} releases (up to 20).\n${releases.filter(r => r.status === 'failed').length} failed releases.\nLatest release: ${releases[0] ? `v${releases[0].version}, ${age(releases[0].created_at)} ago` : 'none'}.`, {id: 'releases', icon: 'releases', tone: releases.some(r => r.status === 'failed') ? 'warning' : 'info',
        columns: ['Releases OK', releases.length, releases.filter(r => r.status === 'succeeded').length, !releases.length ? 'No releases' : releases.some(r => r.status === 'failed') ? `${releases.filter(r => r.status === 'failed').length} failed` : 'Succeeded']}))
    rows.push(row(`Snapshot: ${new Date(data.fetchedAt).toLocaleTimeString()}`, `Platform snapshot: ${data.fetchedAt}\n\nPerformance rows use separate time-bucketed data from api.metrics.heroku.com.\nSelect a metric for its sample time, resolution, coverage, and sparkline.\nPress R to refresh, or o to open the metrics dashboard.`, {id: 'snapshot', icon: 'clock', tone: 'muted',
      columns: ['Snapshot', '—', new Date(data.fetchedAt).toLocaleTimeString(), 'Fetched']}))
  }
  const result = rows.length ? rows : [row('No items', `No ${tab.toLowerCase()} to display.`, {icon: 'search', tone: 'muted', columns: noticeColumns('No items', 'Empty')})]
  for (const item of result) if (item.columns) item.columnLayout = tab
  return result
}
