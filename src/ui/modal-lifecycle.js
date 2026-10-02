export class ModalLifecycle {
  constructor(owner, modal, {onClose = () => {}} = {}) {
    this.owner = owner
    this.modal = modal
    this.previous = owner.screen.focused
    this.onClose = onClose
    this.cleanups = []
    this.closed = false
    this.onDestroy = () => this.close({restoreFocus: false})
    modal.once('destroy', this.onDestroy)
    owner.modal = modal
    owner.modalLifecycle = this
  }

  addCleanup(callback) { this.cleanups.push(callback) }

  close({value = null, restoreFocus = true, render = true} = {}) {
    if (this.closed) return false
    // Mark closed and release ownership before cleanup can trigger callbacks.
    this.closed = true
    const {owner, modal} = this
    const active = owner.modal === modal && owner.modalLifecycle === this
    if (owner.modal === modal) owner.modal = null
    if (owner.modalLifecycle === this) owner.modalLifecycle = null
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    modal.removeListener('destroy', this.onDestroy)
    if (!modal.destroyed) modal.destroy()
    const foreground = active && !owner.closed && !owner.screen.destroyed && !owner.modal
    if (foreground && restoreFocus && !this.previous?.destroyed) this.previous?.focus()
    this.onClose({value, restoreFocus: foreground && restoreFocus})
    if (render && foreground && !owner.closed && !owner.screen.destroyed && !owner.modal) owner.render()
    return true
  }
}
