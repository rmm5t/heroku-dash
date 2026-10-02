import {Command} from '@heroku-cli/command'
import {Flags} from '@oclif/core'
import {HerokuAPI} from '../api.js'
import {loadCommandHistory} from '../command-history.js'
import {appConfirmCommands} from '../heroku-command.js'
import {loadLogFilterHistory} from '../log-filter-history.js'
import {inspectProject, resolveContext} from '../project.js'
import {loadResourcesIntegration} from '../resources.js'

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
    pipeline: Flags.string({char: 'p', description: 'Pipeline name or ID', env: 'HEROKU_DASH_PIPELINE', exclusive: ['app', 'remote']}),
    remote: Flags.string({char: 'r', description: 'Heroku Git remote to use', exclusive: ['app', 'pipeline', 'team']}),
    team: Flags.string({char: 't', description: 'Scope browsing to a team (name or ID)', env: 'HEROKU_DASH_TEAM', exclusive: ['app', 'remote']}),
    'read-only': Flags.boolean({description: 'Disable all remote changes', default: false}),
    refresh: Flags.integer({description: 'Refresh current app every N seconds (0 disables)', env: 'HEROKU_DASH_REFRESH', default: 60, min: 0}),
    demo: Flags.boolean({description: 'Explore an offline demo; no Heroku requests', default: false}),
    theme: Flags.string({description: 'Color theme (auto detects the terminal background)', options: ['auto', 'light', 'dark'], default: 'auto'}),
  }

  async parseOptions() {
    // Explicit app/remote targets override env context; team/pipeline combine
    // and each CLI value takes precedence over its matching environment variable.
    const cliOptions = {...Dash, flags: {...Dash.flags,
      pipeline: {...Dash.flags.pipeline, env: undefined},
      team: {...Dash.flags.team, env: undefined},
    }}
    let parsed = await this.parse(cliOptions)
    const explicitTarget = ['app', 'remote'].some(name => parsed.flags[name] !== undefined)
    if (!explicitTarget && (process.env.HEROKU_DASH_PIPELINE || process.env.HEROKU_DASH_TEAM)) parsed = await this.parse(Dash)
    if (parsed.flags.refresh !== 0 && parsed.flags.refresh < 10) this.error('--refresh must be 0 or at least 10 seconds.')
    return parsed
  }

  async run() {
    const {flags} = await this.parseOptions()
    if (!process.stdin.isTTY || !process.stdout.isTTY) this.error('heroku dash needs an interactive terminal (TTY). Run it directly in your terminal.')
    const {runDashboard} = await import('../ui/dashboard.js')
    if (flags.demo) {
      const {createDemo} = await import('../demo.js')
      return runDashboard({...createDemo(), refresh: flags.refresh, demo: true, theme: flags.theme})
    }
    if (!await this.heroku.getAuth()) this.error('Log in with heroku login before opening dash.')
    // Interactive reauthentication must not take over the full-screen terminal.
    this.heroku.twoFactorPrompt = async () => { throw new Error('This resource requires additional authentication. Authorize it with the Heroku CLI, then reopen dash.') }
    const api = new HerokuAPI(this.heroku, {readOnly: flags['read-only']})
    const [catalog, project] = await Promise.all([api.catalog(), inspectProject()])
    const context = await resolveContext(api, catalog, flags, project)
    const [resources, commandHistory, logFilterHistory] = await Promise.all([
      loadResourcesIntegration(this.config, api),
      loadCommandHistory(this.config.configDir),
      loadLogFilterHistory(this.config.configDir),
    ])
    await runDashboard({api, catalog, context, resources, refresh: flags.refresh, theme: flags.theme,
      appConfirm: appConfirmCommands(this.config.commands), commandHistory, logFilterHistory})
  }
}
