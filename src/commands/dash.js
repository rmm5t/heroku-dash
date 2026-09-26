import {Command} from '@heroku-cli/command'
import {Flags} from '@oclif/core'
import {HerokuAPI} from '../api.js'
import {inspectProject, resolveContext} from '../project.js'

export default class Dash extends Command {
  static promptFlagActive = false
  static baseFlags = Command.baseFlagsWithoutPrompt()
  static description = 'navigate Heroku teams, pipelines, and apps in a rich terminal dashboard'
  static examples = [
    '<%= config.bin %> dash',
    '<%= config.bin %> dash --pipeline my-pipeline',
    '<%= config.bin %> dash --app my-app --read-only',
    '<%= config.bin %> dash --remote staging',
  ]
  static flags = {
    app: Flags.string({char: 'a', description: 'App name or ID', exclusive: ['pipeline', 'remote', 'team']}),
    pipeline: Flags.string({char: 'p', description: 'Pipeline name or ID', exclusive: ['app', 'remote', 'team']}),
    remote: Flags.string({char: 'r', description: 'Heroku Git remote to use', exclusive: ['app', 'pipeline', 'team']}),
    team: Flags.string({char: 't', description: 'Start in a team (name or ID)', exclusive: ['app', 'pipeline', 'remote']}),
    'read-only': Flags.boolean({description: 'Disable all remote changes', default: false}),
    refresh: Flags.integer({description: 'Refresh current app every N seconds (0 disables)', default: 30, min: 0}),
    demo: Flags.boolean({description: 'Explore an offline demo; no Heroku requests', default: false}),
  }

  async run() {
    const {flags} = await this.parse(Dash)
    if (!process.stdin.isTTY || !process.stdout.isTTY) this.error('heroku dash needs an interactive terminal (TTY). Run it directly in your terminal.')
    if (flags.refresh !== 0 && flags.refresh < 10) this.error('--refresh must be 0 or at least 10 seconds.')
    const {runDashboard} = await import('../ui/dashboard.js')
    if (flags.demo) {
      const {createDemo} = await import('../demo.js')
      return runDashboard({...createDemo(), refresh: flags.refresh, demo: true})
    }
    if (!await this.heroku.getAuth()) this.error('Log in with heroku login before opening dash.')
    // Interactive reauthentication must not take over the full-screen terminal.
    this.heroku.twoFactorPrompt = async () => { throw new Error('This resource requires additional authentication. Authorize it with the Heroku CLI, then reopen dash.') }
    const api = new HerokuAPI(this.heroku, {readOnly: flags['read-only']})
    const [catalog, project] = await Promise.all([api.catalog(), inspectProject()])
    const context = await resolveContext(api, catalog, flags, project)
    if (flags.team) {
      context.team = catalog.teams.find(t => t.id === flags.team || t.name === flags.team)
      if (!context.team) this.error(`Team not found: ${flags.team}`)
    }
    await runDashboard({api, catalog, context, refresh: flags.refresh})
  }
}
