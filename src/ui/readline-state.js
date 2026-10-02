export class ReadlineState {
  constructor({value = '', history = []} = {}) {
    this.characters = [...value]
    this.cursor = this.characters.length
    this.history = history
    this.historyIndex = history.length
    this.draft = value
    this.killed = ''
  }

  get value() { return this.characters.join('') }

  replace(value) {
    this.characters = [...value]
    this.cursor = this.characters.length
  }

  selectHistory(direction) {
    if (!this.history.length) return null
    if (this.historyIndex === this.history.length) {
      this.draft = this.value
      // A displayed newest entry is already selected; move straight past it.
      if (direction < 0 && this.draft === this.history.at(-1)) this.historyIndex--
    }
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + direction))
    this.replace(this.historyIndex === this.history.length ? this.draft : this.history[this.historyIndex])
    return 'refresh'
  }

  previousWord() {
    let index = this.cursor
    while (index > 0 && /\s/.test(this.characters[index - 1])) index--
    while (index > 0 && !/\s/.test(this.characters[index - 1])) index--
    return index
  }

  nextWord() {
    let index = this.cursor
    while (index < this.characters.length && /\s/.test(this.characters[index])) index++
    while (index < this.characters.length && !/\s/.test(this.characters[index])) index++
    return index
  }

  handleKey(ch, key = {}) {
    if (key.name === 'enter' || key.name === 'return') return 'submit'
    if (key.name === 'escape') return 'cancel'
    if ((key.ctrl && key.name === 'a') || key.name === 'home') this.cursor = 0
    else if ((key.ctrl && key.name === 'e') || key.name === 'end') this.cursor = this.characters.length
    else if ((key.ctrl && key.name === 'b') || key.name === 'left') this.cursor = Math.max(0, this.cursor - 1)
    else if ((key.ctrl && key.name === 'f') || key.name === 'right') this.cursor = Math.min(this.characters.length, this.cursor + 1)
    else if (key.meta && key.name === 'b') this.cursor = this.previousWord()
    else if (key.meta && key.name === 'f') this.cursor = this.nextWord()
    else if ((key.ctrl && key.name === 'p') || key.name === 'up') return this.selectHistory(-1)
    else if ((key.ctrl && key.name === 'n') || key.name === 'down') return this.selectHistory(1)
    else if (key.ctrl && key.name === 't') {
      if (this.cursor > 0 && this.characters.length > 1) {
        const index = this.cursor === this.characters.length ? this.cursor - 2 : this.cursor - 1
        const left = this.characters[index]
        this.characters[index] = this.characters[index + 1]
        this.characters[index + 1] = left
        this.cursor = Math.min(this.characters.length, this.cursor + 1)
      }
    } else if (key.ctrl && key.name === 'u') {
      this.killed = this.characters.splice(0, this.cursor).join('')
      this.cursor = 0
    } else if (key.ctrl && key.name === 'k') {
      this.killed = this.characters.splice(this.cursor).join('')
    } else if (key.ctrl && key.name === 'w') {
      const index = this.previousWord()
      this.killed = this.characters.splice(index, this.cursor - index).join('')
      this.cursor = index
    } else if (key.ctrl && key.name === 'y') {
      const inserted = [...this.killed]
      this.characters.splice(this.cursor, 0, ...inserted)
      this.cursor += inserted.length
    } else if ((key.ctrl && key.name === 'd') || key.name === 'delete') {
      if (this.cursor < this.characters.length) this.characters.splice(this.cursor, 1)
    } else if (key.meta && key.name === 'd') {
      this.killed = this.characters.splice(this.cursor, this.nextWord() - this.cursor).join('')
    } else if (key.name === 'backspace') {
      if (this.cursor > 0) this.characters.splice(--this.cursor, 1)
    } else if (ch && !/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]$/.test(ch)) {
      // Keyboard input can deliver surrogate halves separately; combine them
      // before indexing so editing always moves by Unicode code point.
      const prefix = this.characters.slice(0, this.cursor).join('') + ch
      this.characters = [...prefix, ...this.characters.slice(this.cursor)]
      this.cursor = [...prefix].length
    }
    return 'refresh'
  }
}
