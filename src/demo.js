import {HerokuAPI} from './api.js'
import {metricProcesses, metricsTimeframe, normalizeMetric} from './metrics.js'

export function demoTelemetry(data, now = Date.now(), windowHours = 2) {
  const step = metricsTimeframe(windowHours).stepMinutes
  const end = Math.floor(now / (step * 60_000)) * step * 60_000
  const start = end - windowHours * 60 * 60_000
  const length = windowHours * 60 / step
  const wave = (base, amplitude) => Array.from({length}, (_, i) => i === Math.floor(length / 2) ? null : base + Math.sin(i / 8) * amplitude)
  const metric = series => normalizeMetric({start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(), step, data: series}, {start, end})
  return {
    appId: data.app.id, fetchedAt: new Date(now).toISOString(), windowHours, errors: {},
    router: {
      status: metric({'200': wave(120, 40).map(value => value === null ? null : Math.round(value * step)), '500': wave(1, 1).map(value => value === null ? null : Math.round(value * step))}),
      latency: metric(Object.fromEntries([['p50', 80], ['p95', 180], ['p99', 300], ['max', 500]].map(([key, value]) => [`latency.ms.${key}`, wave(value, value / 4)]))),
    },
    processes: Object.fromEntries(metricProcesses(data).map(process => [process.type, {
      memory: metric({
        'memory.swap-plus-rss.bytes.mean': wave(180 * 1024 ** 2, 25 * 1024 ** 2),
        'memory.rss.bytes.max': wave(200 * 1024 ** 2, 25 * 1024 ** 2),
        'memory.swap.bytes.max': wave(2 * 1024 ** 2, 1024 ** 2),
        'memory.total.bytes.max': wave(210 * 1024 ** 2, 25 * 1024 ** 2),
        'memory.quota.bytes.max': wave((process.size === 'Standard-2X' ? 1024 : 512) * 1024 ** 2, 0),
      }),
      load: metric({'load.avg.1m.mean': wave(0.25, 0.15), 'load.avg.1m.max': wave(0.4, 0.2)}),
    }])),
  }
}

export function createDemo() {
  const now = Date.now()
  const ago = seconds => new Date(now - seconds * 1000).toISOString()
  const team = {id: 'team-demo', name: 'acme'}
  const pipeline = {id: 'pipeline-demo', name: 'constellation', owner: {id: team.id, type: 'team'}}
  const apps = ['staging', 'production'].map(stage => ({
    id: `app-${stage}`, name: `constellation-${stage}`, stage, team,
    region: {name: 'us'}, stack: {name: 'heroku-24'}, build_stack: {name: 'heroku-24'},
    web_url: `https://constellation-${stage}.herokuapp.com`, maintenance: false, acm: true,
    created_at: ago(86400 * 90), updated_at: ago(3600),
  }))
  const data = app => ({app, coupling: {pipeline: {id: pipeline.id, name: pipeline.name}}, errors: {}, fetchedAt: new Date().toISOString(),
    formation: [{type: 'web', quantity: 2, size: 'Standard-1X', command: 'npm start'}, {type: 'worker', quantity: 1, size: 'Standard-2X', command: 'node worker.js'}],
    dynos: ['web.1', 'web.2', 'worker.1'].map(name => ({name, type: name.split('.')[0], state: 'up', size: name.startsWith('web') ? 'Standard-1X' : 'Standard-2X', created_at: ago(4700), command: 'node server.js', release: {version: 42}})),
    addons: [{id: 'postgres', name: 'postgresql-orbit-12345', plan: {name: 'heroku-postgresql:essential-0'}, addon_service: {name: 'heroku-postgresql'}, state: 'provisioned', app, config_vars: ['DATABASE_URL']}],
    attachments: [{name: 'DATABASE', addon: {id: 'postgres'}}],
    domains: [{hostname: `${app.name}.herokuapp.com`, kind: 'heroku', status: 'succeeded'}],
    buildpacks: [{ordinal: 1, buildpack: {name: 'heroku/nodejs', url: 'heroku/nodejs'}}],
    releases: [42, 41, 40].map((version, i) => ({version, status: 'succeeded', description: i ? 'Update config vars' : 'Deploy a1b2c3d', created_at: ago(4700 + i * 86400), user: {email: 'developer@example.com'}})),
  })
  // Use the real API's read-only guards even in the offline demo.
  const api = new HerokuAPI({request() { throw new Error('Demo is offline.') }}, {readOnly: true})
  const catalog = {teams: [team], pipelines: [pipeline], apps, warnings: []}
  api.catalog = async () => structuredClone(catalog)
  api.pipelineApps = async () => structuredClone(apps)
  api.appData = async id => data(apps.find(a => a.id === id || a.name === id))
  api.config = async () => ({NODE_ENV: 'production', EXAMPLE_SECRET: 'demo-only-value', WEB_CONCURRENCY: '2'})
  return {api, catalog, fetchMetrics: async (data, options = {}) => demoTelemetry(data, options.now ?? Date.now(), options.windowHours ?? 2), resources: {available: false, message: 'Cost and limit lookup is disabled in the offline demo.'}, context: {pipeline, reason: 'Offline demo'}}
}
