import {execFile} from 'node:child_process'
import {basename} from 'node:path'
import {promisify} from 'node:util'

const exec = promisify(execFile)

export function parseRemotes(text) {
  const remotes = new Map()
  for (const line of text.split('\n')) {
    const [remote, url] = line.trim().split(/\s+/)
    // Also recognize heroku-accounts SSH aliases (heroku.personal, etc.).
    const match = url?.match(/^(?:https:\/\/git\.heroku\.com\/|(?:ssh:\/\/)?git@(?:git\.)?heroku(?:\.[\w-]+)*(?::|\/))([\w-]+)\.git$/)
    if (match) remotes.set(remote, {remote, app: match[1]})
  }
  return [...remotes.values()]
}

export async function inspectProject(cwd = process.cwd()) {
  try {
    const {stdout: root} = await exec('git', ['rev-parse', '--show-toplevel'], {cwd})
    const {stdout: remotes} = await exec('git', ['remote', '-v'], {cwd})
    return {name: basename(root.trim()), root: root.trim(), remotes: parseRemotes(remotes)}
  } catch {
    return {name: null, root: null, remotes: []}
  }
}

export function uniquePipeline(pipelines, nameOrId) {
  const matches = pipelines.filter(p => p.id === nameOrId || p.name === nameOrId)
  if (matches.length > 1) throw new Error(`Multiple pipelines named ${nameOrId}; use --pipeline with an ID: ${matches.map(p => p.id).join(', ')}`)
  if (!matches.length) throw new Error(`Pipeline not found: ${nameOrId}`)
  return matches[0]
}

export async function resolveContext(api, catalog, options = {}, project = {}) {
  const byApp = async name => {
    const app = await api.get(`/apps/${encodeURIComponent(name)}`)
    const coupling = await api.coupling(app.id)
    return {app, pipeline: coupling?.pipeline ?? null}
  }
  if (options.app) return {...await byApp(options.app), reason: `App: ${options.app}`}
  if (options.pipeline) return {pipeline: uniquePipeline(catalog.pipelines, options.pipeline), reason: 'Explicit pipeline'}
  if (options.remote) {
    const remote = project.remotes?.find(r => r.remote === options.remote)
    if (!remote) throw new Error(`No Heroku Git remote named ${options.remote} in this repository.`)
    return {...await byApp(remote.app), reason: `Git remote: ${remote.remote}`}
  }
  // An explicit team is a browsing scope, not a request to select a local app.
  if (options.team) return {reason: `Team: ${options.team}`}
  const contexts = []
  const warnings = []
  for (const remote of project.remotes ?? []) {
    try {
      contexts.push(await byApp(remote.app))
    } catch (error) {
      warnings.push(`${remote.remote}: ${error.message}`)
    }
  }
  const pipelineIds = new Set(contexts.map(c => c.pipeline?.id).filter(Boolean))
  if (pipelineIds.size === 1) {
    const context = contexts.find(c => c.pipeline)
    return {pipeline: context.pipeline, reason: 'Pipeline from Git remotes', warnings}
  }
  if (pipelineIds.size > 1) return {reason: 'Git remotes span multiple pipelines; choose one, or use --remote.', warnings}
  if (project.name) {
    const matches = catalog.pipelines.filter(p => p.name === project.name)
    if (matches.length === 1) return {pipeline: matches[0], reason: 'Pipeline matches repository name', warnings}
    if (matches.length > 1) return {reason: 'Repository matches multiple pipelines; choose one, or use --pipeline ID.', warnings}
  }
  if (contexts.length === 1) return {...contexts[0], reason: 'App from Git remote', warnings}
  return {reason: 'Choose a team, pipeline, or app to get started.', warnings}
}
