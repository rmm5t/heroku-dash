// All remote text is untrusted terminal content. No ANSI escapes, control codes,
// or blessed tags are interpreted by the widgets that display it.
export function clean(value) {
  return String(value ?? '—').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}
export function single(value) { return clean(value).replace(/[\r\n\t]/g, ' ') }
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

export function appRows(tab, data, {config, configError, revealed = null} = {}) {
  const {app, formation, dynos, addons, attachments, releases, domains, buildpacks, errors} = data
  const rows = []
  const error = section => {
    if (errors[section]) rows.push(row(`! ${section} unavailable`, errors[section]))
  }
  if (tab === 'Overview') {
    rows.push(row(`${app.name}  ·  ${app.maintenance ? 'MAINTENANCE' : 'ACTIVE'}`, lines([
      ['App', app.name], ['Team', app.team?.name ?? 'Personal / shared'], ['Region', app.region?.name],
      ['Stack', app.stack?.name], ['Generation', app.generation?.name], ['Web URL', app.web_url],
      ['Git URL', app.git_url], ['Created', app.created_at], ['Updated', app.updated_at], ['ID', app.id],
    ])))
    rows.push(row(`${formation.reduce((n, f) => n + f.quantity, 0)} configured dynos  ·  ${addons.length} add-ons`,
      'Use Resources to inspect and scale process types.\nUse Add-ons to inspect plans and attachments.\nConfig values are masked until explicitly revealed.'))
    for (const f of formation) rows.push(row(`${f.type}  ·  ${f.quantity} × ${f.size}`, f.command))
    if (releases[0]) rows.push(row(`Latest release: v${releases[0].version}  ·  ${releases[0].status}`, releases[0].description))
    for (const section of Object.keys(errors)) error(section)
  }
  if (tab === 'Resources') {
    error('formation'); error('dynos')
    for (const f of formation) rows.push(row(`▸ ${f.type.padEnd(16)} ${String(f.quantity).padStart(3)} × ${f.size}    [s] scale`, lines([
      ['Process', f.type], ['Quantity', f.quantity], ['Size', f.size], ['Command', f.command],
      ['Updated', f.updated_at], ['Action', 'Press s to change quantity / size. Scaling may change billing.'],
    ]), {kind: 'formation', value: f}))
    for (const d of dynos) rows.push(row(`  ${d.name.padEnd(20)} ${d.state.padEnd(10)} ${d.size}  ·  ${age(d.created_at)}`, lines([
      ['Dyno', d.name], ['State', d.state], ['Size', d.size], ['Release', d.release ? `v${d.release.version}` : '—'],
      ['Created', d.created_at], ['Command', d.command],
    ])))
  }
  if (tab === 'Add-ons') {
    error('addons'); error('attachments')
    const all = new Map(addons.map(addon => [addon.id, addon]))
    for (const attachment of attachments) if (!all.has(attachment.addon.id)) all.set(attachment.addon.id, attachment.addon)
    for (const addon of all.values()) rows.push(row(`${addon.name}  ·  ${addon.plan?.name ?? 'shared attachment'}  ·  ${addon.state ?? '—'}`, lines([
      ['Name', addon.name], ['Service', addon.addon_service?.name], ['Plan', addon.plan?.name],
      ['State', addon.state], ['Billing app', addon.app?.name], ['Created', addon.created_at],
      ['Attachments', attachments.filter(a => a.addon.id === addon.id).map(a => a.name).join(', ') || '—'],
      ['Config keys', addon.config_vars?.join(', ')], ['ID', addon.id],
    ])))
  }
  if (tab === 'Config') {
    if (configError) rows.push(row('! Config vars unavailable', configError))
    else if (!config) rows.push(row('Loading config vars…', 'Config vars are fetched only when you open this tab.'))
    else for (const key of Object.keys(config).sort()) rows.push(row(`${key} = ${key === revealed ? single(config[key]) : '••••••••'}`,
      `${key}\n\n${key === revealed ? clean(config[key]) : 'Value hidden. Press v to reveal this variable.'}\n\n[e] replace value   [n] new variable   [d] delete\nConfig changes create a release and restart the app.`, {kind: 'config', key}))
  }
  if (tab === 'Settings') {
    rows.push(row(`Maintenance mode: ${app.maintenance ? 'ON' : 'OFF'}    [m] toggle`, 'Press m to toggle maintenance mode. This changes how the app serves requests.'))
    rows.push(row(`Region: ${app.region?.name}  ·  Stack: ${app.stack?.name}`, lines([
      ['Region', app.region?.name], ['Stack', app.stack?.name], ['Build stack', app.build_stack?.name],
      ['Space', app.space?.name ?? 'Common Runtime'], ['ACM', app.acm ? 'Enabled' : 'Disabled'],
    ])))
    error('domains'); error('buildpacks')
    for (const domain of domains) rows.push(row(`Domain  ${domain.hostname}`, lines([
      ['Hostname', domain.hostname], ['Kind', domain.kind], ['CNAME', domain.cname],
      ['Status', domain.status], ['ACM status', domain.acm_status], ['ACM reason', domain.acm_status_reason],
    ])))
    for (const item of buildpacks) rows.push(row(`Buildpack  ${item.ordinal}. ${item.buildpack?.name ?? item.buildpack?.url}`, item.buildpack?.url))
  }
  if (tab === 'Releases') {
    error('releases')
    for (const release of releases) rows.push(row(`v${String(release.version).padEnd(5)} ${release.status.padEnd(10)} ${age(release.created_at).padEnd(7)} ${release.description}`, lines([
      ['Version', `v${release.version}`], ['Status', release.status], ['Description', release.description],
      ['User', release.user?.email], ['Created', release.created_at], ['ID', release.id],
    ])))
  }
  if (tab === 'Metrics') {
    error('dynos'); error('formation'); error('releases')
    const m = operationalMetrics(data)
    const available = !errors.dynos && !errors.formation
    rows.push(row(`Dyno health    ${available ? `${m.healthy} / ${m.desired} configured dynos up or idle` : 'unavailable'}`, available
      ? `${m.healthy} up / idle   ${m.starting} starting   ${m.crashed} crashed\n${m.total} total dynos, including one-off processes.\n\nBased on current dyno states, not historical availability.\nEco dynos in the idle state are counted as healthy.\nDuring a deploy, overlapping dynos can exceed the desired count.`
      : 'Dyno health cannot be computed because formation or dyno data is unavailable.'))
    for (const f of formation) {
      const members = dynos.filter(d => d.type === f.type)
      rows.push(row(`${f.type}  ·  desired ${f.quantity}  ·  running ${members.filter(d => ['up', 'idle'].includes(d.state)).length}`, members.map(d => `${d.name.padEnd(22)} ${d.state.padEnd(10)} age ${age(d.created_at)}`).join('\n') || 'No dynos currently running.'))
    }
    if (!errors.releases) rows.push(row(`Deployments    ${releases.filter(r => r.status === 'succeeded').length} succeeded / ${releases.length} recent releases`,
      `Latest ${releases.length} releases (up to 20).\n${releases.filter(r => r.status === 'failed').length} failed releases.\nLatest release: ${releases[0] ? `v${releases[0].version}, ${age(releases[0].created_at)} ago` : 'none'}.`))
    rows.push(row('Telemetry availability', 'CPU, memory, throughput, and latency charts are not exposed by the public Heroku Platform API.\n\nThis view shows live operational snapshots, not APM time-series metrics.\nPress o to open the app’s metrics page in the web dashboard.'))
    rows.push(row(`Snapshot: ${new Date(data.fetchedAt).toLocaleTimeString()}`, 'Press R to refresh. Automatic refresh follows --refresh (default: 30 seconds).'))
  }
  return rows.length ? rows : [row('No items', `No ${tab.toLowerCase()} to display.`)]
}
